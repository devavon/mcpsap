import "./taskpane.css";
import { SapApi, type EntityMeta, type FilterDef, type Profile, type QueryResult } from "./api";
import { ICONS, entityIcon } from "./icons";

const api = new SapApi();
let entities: EntityMeta[] = [];
let combo: EntityCombo;
let lastResult: QueryResult | null = null;

const LS_QUERY = "sapaddin.lastQuery";
const PREVIEW_ROWS = 8;

/** Caché de opciones de dropdowns dinámicos (source), por entidad. Se limpia al cambiar de empresa. */
const sourceOptionsCache = new Map<string, Promise<{ value: string; label: string }[]>>();

/* ---------------- helpers DOM ---------------- */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string) => $(id).classList.remove("hidden");
const hide = (id: string) => $(id).classList.add("hidden");
const val = (id: string) => ($(id) as HTMLInputElement).value.trim();

function setBusy(btn: HTMLButtonElement, busy: boolean, busyLabel?: string): void {
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${busyLabel ?? ""}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

function msg(kind: "info" | "success" | "error" | "warning", text: string): void {
  const bar = $("msgbar");
  bar.className = `msgbar ${kind}`;
  bar.innerHTML = `<span class="mb-text"></span><button class="mb-close" aria-label="Cerrar">×</button>`;
  (bar.querySelector(".mb-text") as HTMLElement).textContent = text;
  (bar.querySelector(".mb-close") as HTMLElement).onclick = () => hide("msgbar");
}
const clearMsg = () => hide("msgbar");

function setStatus(online: boolean, label?: string): void {
  const pill = $("statusPill");
  pill.className = `status-pill ${online ? "online" : "offline"}`;
  $("statusText").textContent = online ? label || "Conectado" : "Sin conexión";
}

/* ---------------- arranque ---------------- */
Office.onReady((info) => {
  if (info.host !== Office.HostType.Excel) {
    document.body.innerHTML = '<p style="padding:16px">Este complemento solo funciona en Excel.</p>';
    return;
  }

  $("btnSettings").innerHTML = ICONS.gear;
  $("btnLogout").innerHTML = ICONS.logout;

  ($("apiUrl") as HTMLInputElement).value = api.getBaseUrl();
  combo = new EntityCombo($("entityCombo"), onEntityChange);

  $("apiUrl").addEventListener("change", () => api.setBaseUrl(val("apiUrl")));
  $("btnSettings").addEventListener("click", () => $("settings").classList.toggle("hidden"));
  $("btnLogin").addEventListener("click", onLogin);
  $("btnLogout").addEventListener("click", onLogout);
  $("btnQuery").addEventListener("click", onQuery);
  $("btnDump").addEventListener("click", onDump);
  $("company").addEventListener("change", onCompanyChange);
  $("password").addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && onLogin());
  // Cualquier cambio de filtros/opciones invalida la vista previa.
  $("filters").addEventListener("input", invalidatePreview);
  $("filters").addEventListener("change", invalidatePreview);
  ["rowLimit", "allColumns", "filter", "orderby"].forEach((id) => {
    $(id).addEventListener("input", invalidatePreview);
    $(id).addEventListener("change", invalidatePreview);
  });

  if (api.hasToken()) {
    setStatus(false, "Reanudando…");
    api.me().then(enterSession).catch(showLogin);
  } else {
    showLogin();
  }
});

function showLogin(): void {
  hide("mainView");
  show("loginView");
  show("settings");
  setStatus(false);
  $("btnLogout").classList.add("hidden");
}

/* ---------------- sesión ---------------- */
async function onLogin(): Promise<void> {
  const u = val("username");
  const p = ($("password") as HTMLInputElement).value;
  if (!u || !p) return msg("warning", "Ingrese usuario y contraseña.");
  api.setBaseUrl(val("apiUrl"));
  clearMsg();
  const btn = $("btnLogin") as HTMLButtonElement;
  setBusy(btn, true, "Verificando…");
  try {
    const profile = await api.login(u, p);
    ($("password") as HTMLInputElement).value = "";
    await enterSession(profile);
  } catch (e) {
    msg("error", (e as Error).message);
  } finally {
    setBusy(btn, false);
  }
}

async function enterSession(profile: Profile): Promise<void> {
  hide("loginView");
  hide("settings");
  show("mainView");
  $("btnLogout").classList.remove("hidden");
  $("footUser").textContent = `${profile.fullName} · ${profile.role} · solo lectura`;

  const saved = loadSavedQuery();

  const sel = $("company") as HTMLSelectElement;
  sel.innerHTML = "";
  for (const c of profile.companies) {
    const o = document.createElement("option");
    o.value = c.alias;
    o.textContent = c.label;
    sel.appendChild(o);
  }
  $("companyField").classList.toggle("hidden", profile.companies.length <= 1);

  let active = profile.selectedCompany;
  if (saved?.company && profile.companies.some((c) => c.alias === saved.company)) active = saved.company;
  if (active) {
    sel.value = active;
    if (active !== profile.selectedCompany) await api.selectCompany(active).catch(() => {});
  } else if (profile.companies.length === 1) {
    await api.selectCompany(profile.companies[0].alias).catch(() => {});
  }

  setStatus(true, sel.value || profile.username);
  await loadEntities(saved);
}

async function onCompanyChange(): Promise<void> {
  const alias = ($("company") as HTMLSelectElement).value;
  clearMsg();
  invalidatePreview();
  sourceOptionsCache.clear(); // socios/cuentas son distintos por empresa
  try {
    await api.selectCompany(alias);
    setStatus(true, alias);
    await loadEntities();
    persistQuery();
  } catch (e) {
    msg("error", (e as Error).message);
  }
}

/**
 * Carga (y cachea) las opciones {value,label} de un filtro "select" dinámico,
 * a partir de la entidad indicada en `source` (ej. "BusinessPartners",
 * "ChartOfAccounts"). El valor es el keyField de la entidad; la etiqueta
 * combina el keyField con el otro campo de búsqueda (por convención, el
 * segundo de `searchFields` es el nombre descriptivo).
 */
function loadSourceOptions(source: string): Promise<{ value: string; label: string }[]> {
  const cached = sourceOptionsCache.get(source);
  if (cached) return cached;

  const promise = (async () => {
    const meta = entities.find((e) => e.name === source);
    const keyField = meta?.keyField;
    if (!keyField) return [];
    const nameField = meta?.searchFields?.find((f) => f !== keyField) ?? keyField;
    const result = await api.query({ entity: source, filters: {}, all: true, allColumns: false });
    const opts = result.rows
      .map((r) => {
        const value = String(r[keyField] ?? "").trim();
        const name = String(r[nameField] ?? "").trim();
        return { value, label: name && name !== value ? `${value} - ${name}` : value };
      })
      .filter((o) => o.value)
      .sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  })();

  sourceOptionsCache.set(source, promise);
  return promise;
}

async function onLogout(): Promise<void> {
  await api.logout();
  combo.clear();
  lastResult = null;
  hide("previewCard");
  msg("info", "Sesión cerrada.");
  showLogin();
}

/* ---------------- entidades / informes ---------------- */
async function loadEntities(saved?: SavedQuery | null): Promise<void> {
  try {
    entities = await api.entities();
  } catch (e) {
    return msg("error", (e as Error).message);
  }
  combo.setItems(entities);
  const want = saved?.entity ?? combo.value;
  combo.select(want && entities.some((e) => e.name === want) ? want : null);
  renderForEntity();
  if (saved) applySaved(saved);
}

function currentEntity(): EntityMeta | undefined {
  return entities.find((e) => e.name === combo.value);
}

function onEntityChange(): void {
  invalidatePreview();
  renderForEntity();
  persistQuery();
}

/** Pinta filtros + opciones acordes a la entidad/informe seleccionado. */
function renderForEntity(): void {
  const e = currentEntity();
  $("entityDesc").textContent = e?.description ?? "";
  renderFilters(e?.filters ?? []);
  const isEntity = !e || e.type === "entity";
  $("rowsBox").classList.toggle("hidden", !isEntity);
  $("advBox").classList.toggle("hidden", !isEntity);
}

function renderFilters(defs: FilterDef[]): void {
  const host = $("filters");
  host.innerHTML = "";
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    // Empareja dos campos de fecha consecutivos en una fila + atajos de rango.
    if (d.type === "date" && defs[i + 1]?.type === "date") {
      host.appendChild(rangePresets(d.key, defs[i + 1].key));
      const row = document.createElement("div");
      row.className = "row";
      row.appendChild(fieldFor(d));
      row.appendChild(fieldFor(defs[i + 1]));
      host.appendChild(row);
      i++;
      continue;
    }
    host.appendChild(fieldFor(d));
  }
}

function fieldFor(d: FilterDef): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = d.label + (d.required ? " *" : "");
  wrap.appendChild(label);

  let control: HTMLElement;
  if (d.type === "select" && d.source) {
    // Dropdown dinámico (ej. socios de negocio, plan de cuentas): input con
    // autocompletar contra un <datalist> que se llena en vivo desde `source`.
    // Se puede dejar vacío (equivale a "todos"/"todas").
    const listId = `dl-${d.key}`;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "control";
    inp.setAttribute("list", listId);
    inp.placeholder = d.placeholder || "Cargando…";
    inp.autocomplete = "off";
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    wrap.appendChild(datalist);
    loadSourceOptions(d.source)
      .then((opts) => {
        datalist.innerHTML = "";
        for (const o of opts) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.label = o.label;
          opt.textContent = o.label;
          datalist.appendChild(opt);
        }
        if (inp.placeholder === "Cargando…") inp.placeholder = d.placeholder || "vacío = todos";
      })
      .catch((e) => msg("error", `No se pudo cargar "${d.label}": ${(e as Error).message}`));
    control = inp;
  } else if (d.type === "select") {
    const s = document.createElement("select");
    s.className = "control";
    for (const o of d.options ?? []) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      s.appendChild(opt);
    }
    control = s;
  } else {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "control";
    if (d.type === "date") {
      inp.placeholder = "DD/MM/AA";
      inp.inputMode = "numeric";
      inp.maxLength = 8;
      inp.autocomplete = "off";
      inp.addEventListener("input", () => (inp.value = maskDate(inp.value)));
    } else if (d.placeholder) {
      inp.placeholder = d.placeholder;
    }
    control = inp;
  }
  (control as HTMLInputElement).dataset.fk = d.key;
  wrap.appendChild(control);
  return wrap;
}

/* ---------------- fechas ----------------
 * En pantalla el usuario ve/escribe DD/MM/AA (año de 2 dígitos); hacia el
 * backend siempre se manda YYYY-MM-DD (formato que esperan las consultas
 * SQL). La conversión ocurre solo al armar los parámetros de la consulta
 * (toApiFilters); el valor "de pantalla" es el que se guarda/restaura.
 */
function maskDate(v: string): string {
  const n = v.replace(/\D/g, "").slice(0, 6);
  const p = [n.slice(0, 2)];
  if (n.length > 2) p.push(n.slice(2, 4));
  if (n.length > 4) p.push(n.slice(4, 6));
  return p.join("/");
}

/** DD/MM/AA (pantalla) -> YYYY-MM-DD (API). Asume siglo 20xx. Si no calza el patrón, se manda tal cual. */
function dmyToIso(v: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(v);
  if (!m) return v;
  const [, d, mo, y] = m;
  return `20${y}-${mo}-${d}`;
}

/** Convierte los valores de filtros a lo que espera la API (fechas -> YYYY-MM-DD). */
function toApiFilters(values: Record<string, string>): Record<string, string> {
  const dateKeys = new Set((currentEntity()?.filters ?? []).filter((f) => f.type === "date").map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) out[k] = dateKeys.has(k) ? dmyToIso(v) : v;
  return out;
}

function fmtDate(d: Date): string {
  const z = (x: number) => String(x).padStart(2, "0");
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
}

function setRange(fromKey: string, toKey: string, from: Date, to: Date): void {
  setFilterValues({ [fromKey]: fmtDate(from), [toKey]: fmtDate(to) });
  invalidatePreview();
  persistQuery();
}

function rangePresets(fromKey: string, toKey: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "chips";
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const presets: [string, () => void][] = [
    ["Mes actual", () => setRange(fromKey, toKey, new Date(y, m, 1), new Date(y, m + 1, 0))],
    ["Mes anterior", () => setRange(fromKey, toKey, new Date(y, m - 1, 1), new Date(y, m, 0))],
    ["Año actual", () => setRange(fromKey, toKey, new Date(y, 0, 1), new Date(y, 11, 31))],
    ["Últimos 30 días", () => setRange(fromKey, toKey, new Date(now.getTime() - 29 * 86400000), now)],
  ];
  for (const [label, fn] of presets) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = label;
    chip.addEventListener("click", fn);
    box.appendChild(chip);
  }
  return box;
}

function getFilterValues(): Record<string, string> {
  const out: Record<string, string> = {};
  $("filters")
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-fk]")
    .forEach((el) => {
      const v = el.value.trim();
      if (v) out[el.dataset.fk!] = v;
    });
  return out;
}

function setFilterValues(values: Record<string, string>): void {
  $("filters")
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-fk]")
    .forEach((el) => {
      const v = values[el.dataset.fk!];
      if (v !== undefined) el.value = v;
    });
}

/* ---------------- consulta + vista previa ---------------- */
function invalidatePreview(): void {
  if (lastResult) {
    lastResult = null;
    hide("previewCard");
    show("emptyState");
  }
}

function buildParams() {
  const e = currentEntity()!;
  const rowLimit = ($("rowLimit") as HTMLSelectElement).value;
  return {
    entity: e.name,
    filters: toApiFilters(getFilterValues()),
    filter: e.type === "entity" ? val("filter") || undefined : undefined,
    orderby: e.type === "entity" ? val("orderby") || undefined : undefined,
    all: e.type === "entity" && rowLimit === "all",
    allColumns: e.type === "entity" ? ($("allColumns") as HTMLInputElement).checked : true,
    top: e.type === "entity" && rowLimit !== "all" ? parseInt(rowLimit, 10) : undefined,
  };
}

async function onQuery(): Promise<void> {
  const e = currentEntity();
  if (!e) return msg("warning", "Primero elige qué datos traer.");
  const missing = (e.filters || []).find((f) => f.required && !getFilterValues()[f.key]);
  if (missing) return msg("warning", `Completa el campo obligatorio: ${missing.label}.`);

  clearMsg();
  const btn = $("btnQuery") as HTMLButtonElement;
  setBusy(btn, true, "Consultando…");
  try {
    lastResult = await api.query(buildParams());
    persistQuery();
    if (!lastResult.rows.length) {
      hide("previewCard");
      renderEmpty("Sin resultados", "No hay registros para esos filtros. Prueba a ampliar el rango o quitar filtros.");
      msg("info", "La consulta no devolvió resultados.");
      return;
    }
    renderPreview(lastResult);
  } catch (err) {
    msg("error", (err as Error).message);
  } finally {
    setBusy(btn, false);
  }
}

function renderEmpty(title: string, body: string): void {
  show("emptyState");
  $("emptyState").innerHTML = `<div class="emoji">🔎</div><p><strong>${title}</strong><br/>${body}</p>`;
}

/** Columnas a mostrar/escribir: usa el orden del informe si viene, si no las calcula. */
function resolveColumns(result: QueryResult): string[] {
  if (result.columns && result.columns.length) return result.columns;
  const seen = new Set<string>();
  const cols: string[] = [];
  const e = currentEntity();
  const add = (k: string) => {
    if (!seen.has(k) && !k.startsWith("odata.") && !k.includes("@")) {
      seen.add(k);
      cols.push(k);
    }
  };
  if (e?.type === "entity" && Array.isArray(e.searchFields)) {
    /* sin defaultSelect en cliente: orden natural de las filas */
  }
  for (const row of result.rows) for (const k of Object.keys(row)) add(k);
  return cols;
}

function cellValue(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

function renderPreview(result: QueryResult): void {
  hide("emptyState");
  show("previewCard");
  const cols = resolveColumns(result); // TODAS las columnas (la previa tiene scroll)

  $("previewNum").textContent = String(result.rows.length);
  $("previewCols").textContent = String(cols.length);
  $("previewCompany").textContent = result.companyLabel;

  const head = $("previewHead");
  head.innerHTML = "";
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }

  const body = $("previewBody");
  body.innerHTML = "";
  for (const row of result.rows.slice(0, PREVIEW_ROWS)) {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const td = document.createElement("td");
      const v = cellValue(row[c]);
      td.textContent = v === "" ? "—" : String(v);
      td.title = td.textContent;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }

  const moreRows = result.rows.length > PREVIEW_ROWS ? ` (vista previa de ${PREVIEW_ROWS})` : "";
  $("btnDump").innerHTML = `${ICONS.download}Volcar ${result.rows.length} fila(s) × ${cols.length} col. a Excel`;
  $("btnDump").setAttribute("title", `Escribe TODAS las columnas y filas${moreRows} como tabla.`);
}

async function onDump(): Promise<void> {
  if (!lastResult || !lastResult.rows.length) return;
  const btn = $("btnDump") as HTMLButtonElement;
  setBusy(btn, true, "Escribiendo…");
  clearMsg();
  try {
    await writeToExcel(lastResult, ($("newSheet") as HTMLInputElement).checked);
    msg("success", `${lastResult.rows.length} fila(s) volcadas a Excel. Empresa: ${lastResult.companyLabel}.`);
  } catch (err) {
    msg("error", `No se pudo escribir en Excel: ${(err as Error).message}`);
  } finally {
    setBusy(btn, false);
  }
}

/* ---------------- persistencia última consulta ---------------- */
interface SavedQuery {
  company?: string;
  entity?: string;
  filters?: Record<string, string>;
  rowLimit?: string;
  allColumns?: boolean;
  newSheet?: boolean;
}

function persistQuery(): void {
  const q: SavedQuery = {
    company: ($("company") as HTMLSelectElement).value || undefined,
    entity: combo.value ?? undefined,
    filters: getFilterValues(),
    rowLimit: ($("rowLimit") as HTMLSelectElement).value,
    allColumns: ($("allColumns") as HTMLInputElement).checked,
    newSheet: ($("newSheet") as HTMLInputElement).checked,
  };
  try {
    localStorage.setItem(LS_QUERY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
}

function loadSavedQuery(): SavedQuery | null {
  try {
    const raw = localStorage.getItem(LS_QUERY);
    return raw ? (JSON.parse(raw) as SavedQuery) : null;
  } catch {
    return null;
  }
}

function applySaved(s: SavedQuery): void {
  if (s.filters) setFilterValues(s.filters);
  if (s.rowLimit) ($("rowLimit") as HTMLSelectElement).value = s.rowLimit;
  if (s.allColumns !== undefined) ($("allColumns") as HTMLInputElement).checked = s.allColumns;
  if (s.newSheet !== undefined) ($("newSheet") as HTMLInputElement).checked = s.newSheet;
}

/* ---------------- escritura en Excel ---------------- */
async function writeToExcel(result: QueryResult, newSheet: boolean): Promise<void> {
  const cols = resolveColumns(result);
  const values = [cols, ...result.rows.map((r) => cols.map((c) => cellValue(r[c])))];
  const baseName = result.entity;

  await Excel.run(async (ctx) => {
    let sheet: Excel.Worksheet;
    if (newSheet) {
      sheet = ctx.workbook.worksheets.add(uniqueSheetName(baseName));
      sheet.activate();
    } else {
      sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.tables.load("items/name");
      const used = sheet.getUsedRangeOrNullObject();
      used.load("isNullObject");
      await ctx.sync();
      sheet.tables.items.forEach((t) => t.delete());
      if (!used.isNullObject) used.clear(Excel.ClearApplyTo.contents);
    }

    const range = sheet.getRangeByIndexes(0, 0, values.length, cols.length);
    // Formato de texto para cadenas numéricas largas (referencias, claves FE…)
    // así Excel no las pasa a notación científica ni pierde dígitos (>15).
    range.numberFormat = values.map((row, r) =>
      row.map((v) => (r > 0 && typeof v === "string" && /^\d{12,}$/.test(v) ? "@" : "General")),
    );
    range.values = values as (string | number | boolean)[][];

    const header = sheet.getRangeByIndexes(0, 0, 1, cols.length);
    header.format.font.bold = true;
    header.format.fill.color = "#0f6cbd";
    header.format.font.color = "white";

    const table = sheet.tables.add(range, true);
    table.name = uniqueTableName(baseName);
    table.getRange().format.autofitColumns();
    await ctx.sync();
  });
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19).replace(/:/g, "");
}
const uniqueSheetName = (base: string) => `${base}_${stamp()}`.slice(0, 31);
const uniqueTableName = (base: string) => `T_${base}_${stamp()}`.replace(/[^A-Za-z0-9_]/g, "");

/* =================================================================
   Combobox de entidades (con iconos y buscador) — vanilla
   ================================================================= */
class EntityCombo {
  private items: EntityMeta[] = [];
  private selected: string | null = null;
  private open = false;
  private trigger!: HTMLButtonElement;
  private pop!: HTMLElement;
  private list!: HTMLElement;
  private searchInput!: HTMLInputElement;

  constructor(private root: HTMLElement, private onChange: () => void) {
    this.render();
    document.addEventListener("click", (e) => {
      if (this.open && !this.root.contains(e.target as Node)) this.setOpen(false);
    });
  }

  get value(): string | null {
    return this.selected;
  }
  setItems(items: EntityMeta[]): void {
    this.items = items;
  }
  select(name: string | null): void {
    this.selected = name;
    this.renderTrigger();
  }
  clear(): void {
    this.items = [];
    this.selected = null;
    this.renderTrigger();
  }

  private render(): void {
    this.root.innerHTML = `
      <button type="button" class="combo-trigger">
        <span class="ci"></span>
        <span class="ct placeholder">Selecciona los datos…</span>
        <span class="cc"></span>
      </button>
      <div class="combo-pop hidden">
        <div class="combo-search"><input type="text" class="control" placeholder="Buscar tipo de dato…" /></div>
        <div class="combo-list"></div>
      </div>`;
    this.trigger = this.root.querySelector(".combo-trigger") as HTMLButtonElement;
    this.pop = this.root.querySelector(".combo-pop") as HTMLElement;
    this.list = this.root.querySelector(".combo-list") as HTMLElement;
    this.searchInput = this.root.querySelector(".combo-search input") as HTMLInputElement;
    (this.trigger.querySelector(".cc") as HTMLElement).innerHTML = ICONS.chevron;
    this.trigger.addEventListener("click", () => this.setOpen(!this.open));
    this.searchInput.addEventListener("input", () => this.renderList(this.searchInput.value));
    this.renderTrigger();
  }

  private renderTrigger(): void {
    const meta = this.items.find((i) => i.name === this.selected);
    const ci = this.trigger.querySelector(".ci") as HTMLElement;
    const ct = this.trigger.querySelector(".ct") as HTMLElement;
    if (meta) {
      ci.innerHTML = entityIcon(meta.kind);
      ct.textContent = meta.label;
      ct.classList.remove("placeholder");
    } else {
      ci.innerHTML = "";
      ct.textContent = "Selecciona los datos…";
      ct.classList.add("placeholder");
    }
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.trigger.classList.toggle("open", open);
    this.pop.classList.toggle("hidden", !open);
    if (open) {
      this.searchInput.value = "";
      this.renderList("");
      setTimeout(() => this.searchInput.focus(), 0);
    }
  }

  private renderList(q: string): void {
    const needle = q.trim().toLowerCase();
    const matches = this.items.filter(
      (i) => !needle || i.label.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle),
    );
    this.list.innerHTML = "";
    if (!matches.length) {
      this.list.innerHTML = `<div class="combo-empty">Sin coincidencias</div>`;
      return;
    }
    // Agrupa informes y datos.
    const groups: [string, EntityMeta[]][] = [
      ["Informes financieros", matches.filter((m) => m.type === "report")],
      ["Datos", matches.filter((m) => m.type === "entity")],
    ];
    for (const [title, items] of groups) {
      if (!items.length) continue;
      const h = document.createElement("div");
      h.className = "combo-group";
      h.textContent = title;
      this.list.appendChild(h);
      for (const m of items) this.list.appendChild(this.itemEl(m));
    }
  }

  private itemEl(m: EntityMeta): HTMLElement {
    const item = document.createElement("div");
    item.className = "combo-item" + (m.name === this.selected ? " selected" : "");
    item.innerHTML = `<span class="ci">${entityIcon(m.kind)}</span><span class="cl"></span>${
      m.name === this.selected ? `<span class="ck">${ICONS.check}</span>` : ""
    }`;
    (item.querySelector(".cl") as HTMLElement).textContent = m.label;
    item.addEventListener("click", () => {
      this.select(m.name);
      this.setOpen(false);
      this.onChange();
    });
    return item;
  }
}
