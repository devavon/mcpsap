import type { ServiceLayerClient } from "./serviceLayer.js";
import { odataString } from "./entities.js";

/**
 * Informes financieros para contabilidad, construidos sobre el Service Layer.
 *
 * Algunos son lectura directa (plan de cuentas); otros se CALCULAN agregando
 * asientos (balance de comprobación, mayor) o facturas abiertas (antigüedad),
 * porque SAP B1 no los expone como un endpoint único.
 *
 * Todos requieren permiso de lectura sobre la entidad lógica "Financials".
 * NOTA: validados contra los esquemas estándar del Service Layer; conviene
 * verificarlos contra la instalación real una vez haya conexión a SAP.
 */

export type FilterType = "text" | "date" | "select";

export interface FilterDef {
  key: string;
  label: string;
  type: FilterType;
  required?: boolean;
  placeholder?: string;
  /** Opciones fijas para un filtro "select" (ej. cSupplier/cCustomer). */
  options?: { value: string; label: string }[];
  /**
   * Para un filtro "select" sin `options` fijas: nombre de la entidad (ver
   * ENTITIES) desde donde el cliente debe cargar las opciones en vivo contra
   * SAP — usando su keyField como valor y "keyField - Name" como etiqueta.
   * Ej. "BusinessPartners" (CardCode/CardName) o "ChartOfAccounts"
   * (Code/Name). Útil cuando la lista es dinámica y no cabe como catálogo
   * fijo (ej. socios de negocio, plan de cuentas).
   */
  source?: string;
}

export interface ReportResult {
  rows: Record<string, unknown>[];
  /** Orden sugerido de columnas para Excel/preview. */
  columns?: string[];
}

export interface ReportDef {
  name: string;
  label: string;
  /** Sustantivo/categoría para el icono del add-in. */
  kind: "journal" | "payment" | "master" | "salesDoc" | "purchaseDoc";
  description: string;
  filters: FilterDef[];
  /** Informe basado en Service Layer (opcional si usa SQL). */
  run?: (client: ServiceLayerClient, f: Record<string, string>) => Promise<ReportResult>;
  /**
   * Informe basado en SQL directo a HANA: devuelve el SQL parametrizado (con
   * '?') y los parámetros en orden. Se ejecuta sobre el esquema de la empresa
   * seleccionada. Requiere HANA configurado.
   */
  sql?: (f: Record<string, string>) => { text: string; params: any[] };
  /**
   * Post-procesamiento en JS de las filas crudas devueltas por `sql` (ej. para
   * armar jerarquías con subtotales). Si no se define, las filas de `sql` se
   * devuelven tal cual, con columnas = claves de la primera fila.
   */
  post?: (rows: Record<string, unknown>[], f: Record<string, string>) => ReportResult;
}

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? 0)) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Recorta la hora de cualquier valor tipo fecha/hora (columnas TIMESTAMP de
 * HANA que vienen con hora aunque el dato solo tenga sentido por día, ej.
 * fechas de pago en procedimientos como BMT_FLUJO_CAJA), dejando solo
 * YYYY-MM-DD. No toca columnas que ya son fecha pura ni el resto de valores.
 */
function stripTimeOfDay(rows: Record<string, unknown>[]): ReportResult {
  const out = rows.map((r) => {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v instanceof Date) row[k] = v.toISOString().slice(0, 10);
      else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v)) row[k] = v.slice(0, 10);
      else row[k] = v;
    }
    return row;
  });
  return { rows: out, columns: out.length ? Object.keys(out[0]) : undefined };
}

/** Días entre dos fechas YYYY-MM-DD (a - b). */
function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((da - db) / 86_400_000);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// --------------------------- Plan de cuentas ---------------------------

async function chartOfAccounts(client: ServiceLayerClient, f: Record<string, string>): Promise<ReportResult> {
  const filters: string[] = [];
  if (f.search) {
    const t = f.search.trim();
    const variants = [...new Set([t, t.toLowerCase(), t.toUpperCase()])];
    const ors = variants.flatMap((v) => [`contains(Code,${odataString(v)})`, `contains(Name,${odataString(v)})`]);
    filters.push(`(${ors.join(" or ")})`);
  }
  if (f.activeOnly === "true") filters.push(`ActiveAccount eq 'tYES'`);
  const q =
    `$select=Code,Name,AcctCurrency&` +
    (filters.length ? `$filter=${encodeURIComponent(filters.join(" and "))}&` : "") +
    `$orderby=Code`;
  const rows = await client.getAll<Record<string, unknown>>("ChartOfAccounts", q);
  return { rows, columns: ["Code", "Name", "AcctCurrency"] };
}

/** Ordena columnas: primero las preferidas presentes, luego el resto. */
function orderColumns(rows: Record<string, unknown>[], preferred: string[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  const add = (k: string) => {
    if (!seen.has(k) && !k.startsWith("odata.") && !k.includes("@")) {
      seen.add(k);
      cols.push(k);
    }
  };
  if (rows[0]) {
    for (const k of preferred) if (k in rows[0]) add(k);
    for (const r of rows) for (const k of Object.keys(r)) add(k);
  }
  return cols;
}

// ----------------------- Asientos del rango (base) -----------------------

interface JeLine {
  AccountCode?: string;
  ShortName?: string;
  Debit?: number; // colones (moneda local)
  Credit?: number;
  DebitSys?: number; // dólares (moneda de sistema)
  CreditSys?: number;
  FCCurrency?: string;
  FCDebit?: number;
  FCCredit?: number;
  DueDate?: string;
  LineMemo?: string;
  Reference1?: string;
  Reference2?: string;
  ContraAccount?: string;
}
interface JournalEntry {
  JdtNum?: number;
  Number?: number;
  ReferenceDate?: string;
  Memo?: string;
  Reference?: string;
  JournalEntryLines?: JeLine[];
}

/**
 * Trae los asientos (con líneas) en un rango de ReferenceDate.
 *
 * En SAP B1 Service Layer las JournalEntryLines NO son navigation property: ya
 * vienen embebidas en cada asiento, así que NO se usa $expand. Se omite $select
 * para que el cuerpo incluya la colección de líneas.
 */
async function fetchJournal(
  client: ServiceLayerClient,
  dateFrom: string,
  dateTo: string,
): Promise<JournalEntry[]> {
  const f: string[] = [];
  if (dateFrom) f.push(`ReferenceDate ge '${dateFrom}'`);
  if (dateTo) f.push(`ReferenceDate le '${dateTo}'`);
  // $select limita los campos de cabecera (la entidad tiene ~50) pero conserva
  // la colección de líneas embebida, reduciendo bastante el tamaño de respuesta.
  const q =
    `$select=JdtNum,ReferenceDate,Memo,Reference,JournalEntryLines` +
    (f.length ? `&$filter=${encodeURIComponent(f.join(" and "))}` : "") +
    `&$orderby=ReferenceDate`;
  return client.getAll<JournalEntry>("JournalEntries", q);
}

/** Mapa AccountCode -> Nombre, desde el plan de cuentas (para nombrar cuentas). */
async function accountNames(client: ServiceLayerClient): Promise<Map<string, string>> {
  const coa = await client.getAll<{ Code?: string; Name?: string }>(
    "ChartOfAccounts",
    `$select=Code,Name`,
  );
  const m = new Map<string, string>();
  for (const a of coa) if (a.Code) m.set(a.Code, a.Name ?? "");
  return m;
}

/** Mapa CardCode -> Nombre del socio (para la contrapartida del asiento). */
async function partnerNames(client: ServiceLayerClient): Promise<Map<string, string>> {
  const bp = await client.getAll<{ CardCode?: string; CardName?: string }>(
    "BusinessPartners",
    `$select=CardCode,CardName`,
  );
  const m = new Map<string, string>();
  for (const b of bp) if (b.CardCode) m.set(b.CardCode, b.CardName ?? "");
  return m;
}

/**
 * Movimientos SAP: todas las líneas de asientos del periodo (equivalente al
 * query OJDT+JDT1+OACT+OCRD), con entradas/salidas en USD (FCDebit/FCCredit,
 * moneda extranjera del asiento) y en colones (Debit/Credit, moneda local).
 */
async function movimientosSAP(client: ServiceLayerClient, f: Record<string, string>): Promise<ReportResult> {
  const [jes, accNames, bpN] = await Promise.all([
    fetchJournal(client, f.dateFrom, f.dateTo),
    accountNames(client),
    partnerNames(client),
  ]);

  const rows: Record<string, unknown>[] = [];
  for (const je of jes) {
    for (const l of je.JournalEntryLines ?? []) {
      const memo = l.LineMemo && l.LineMemo.trim() !== "" ? l.LineMemo : je.Memo;
      const contra = l.ContraAccount ?? "";
      const isBP = bpN.has(contra);
      rows.push({
        FechaSAP: je.ReferenceDate,
        Documento: je.Reference ?? null,
        Concepto: memo ?? null,
        Cuenta: l.AccountCode,
        NombreCuenta: accNames.get(l.AccountCode ?? "") ?? l.ShortName ?? "",
        CodigoSocio: isBP ? contra : "",
        NombreSocio: isBP ? bpN.get(contra) ?? "" : "",
        Referencia1: l.Reference1 ?? "",
        Referencia2: l.Reference2 ?? "",
        Referencia3: (l as Record<string, unknown>).Reference3 ?? "",
        "Débito USD": num(l.FCDebit) > 0 ? round2(num(l.FCDebit)) : 0,
        "Crédito USD": num(l.FCCredit) > 0 ? round2(num(l.FCCredit)) : 0,
        "Débito COL": num(l.Debit) > 0 ? round2(num(l.Debit)) : 0,
        "Crédito COL": num(l.Credit) > 0 ? round2(num(l.Credit)) : 0,
      });
    }
  }

  return {
    rows,
    columns: [
      "FechaSAP", "Documento", "Concepto", "Cuenta", "NombreCuenta",
      "CodigoSocio", "NombreSocio", "Referencia1", "Referencia2", "Referencia3",
      "Débito USD", "Crédito USD", "Débito COL", "Crédito COL",
    ],
  };
}

// ----------------------- Mayor / Libro mayor -----------------------

/**
 * Origen del asiento según el tipo de documento que lo generó (OJDT.TransType,
 * el código de objeto estándar de SAP B1). Mapeo acordado con el cliente:
 * AS=Asiento manual, RF=factura de clientes, PC=nota de crédito, TT=factura de
 * proveedores, RC=pago recibido (cobro), PP=pago realizado. Si el TransType no
 * calza con esta lista, se muestra el código numérico crudo (para detectarlo).
 */
const ORIGEN_CASE = `
    CASE T0."TransType"
      WHEN 30 THEN 'AS'
      WHEN 13 THEN 'RF'
      WHEN 14 THEN 'PC'
      WHEN 19 THEN 'PC'
      WHEN 18 THEN 'TT'
      WHEN 24 THEN 'RC'
      WHEN 46 THEN 'PP'
      ELSE TO_VARCHAR(T0."TransType")
    END`;

// ----------------------- Saldos y antigüedad de socios -----------------------

async function partnerAging(client: ServiceLayerClient, f: Record<string, string>): Promise<ReportResult> {
  const isSupplier = f.cardType === "cSupplier";
  const asOf = (f.asOfDate || today()).slice(0, 10);
  const resource = isSupplier ? "PurchaseInvoices" : "Invoices";

  // Facturas abiertas del tipo de socio.
  const inv = await client.getAll<Record<string, any>>(
    resource,
    `$select=CardCode,CardName,DocDueDate,DocTotal,PaidToDate&$filter=DocumentStatus eq 'bost_Open'`,
  );

  interface Bucket {
    CardName: string;
    porVencer: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90: number;
  }
  const map = new Map<string, Bucket>();
  for (const d of inv) {
    const code = d.CardCode as string;
    const open = round2(num(d.DocTotal) - num(d.PaidToDate));
    if (open === 0) continue;
    const b = map.get(code) ?? { CardName: d.CardName ?? "", porVencer: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    const overdue = d.DocDueDate ? daysBetween(asOf, String(d.DocDueDate).slice(0, 10)) : 0;
    if (overdue <= 0) b.porVencer += open;
    else if (overdue <= 30) b.d1_30 += open;
    else if (overdue <= 60) b.d31_60 += open;
    else if (overdue <= 90) b.d61_90 += open;
    else b.d90 += open;
    map.set(code, b);
  }

  const rows = [...map.entries()]
    .map(([code, b]) => {
      const total = round2(b.porVencer + b.d1_30 + b.d31_60 + b.d61_90 + b.d90);
      return {
        CardCode: code,
        Socio: b.CardName,
        PorVencer: round2(b.porVencer),
        "1-30": round2(b.d1_30),
        "31-60": round2(b.d31_60),
        "61-90": round2(b.d61_90),
        "90+": round2(b.d90),
        Total: total,
        Vencido: round2(total - b.porVencer),
      };
    })
    .sort((a, b) => b.Total - a.Total);

  return {
    rows,
    columns: ["CardCode", "Socio", "PorVencer", "1-30", "31-60", "61-90", "90+", "Vencido", "Total"],
  };
}

// --------------------- Balance de comprobación (jerárquico) ---------------------

/**
 * Extrae números de asiento (JDT1.TransId) válidos de un texto separado por
 * comas/espacios, para excluirlos del cálculo (ej. el asiento de cierre de
 * periodo) y así ver el balance "antes del cierre".
 */
function sanitizeTransIds(raw?: string): number[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map(Number),
    ),
  ];
}

const TB_CURRENT_COLS = [
  "Saldo inicial ₡", "Débitos ₡", "Créditos ₡", "Saldo final ₡",
  "Saldo inicial $", "Débitos $", "Créditos $", "Saldo final $",
];
const TB_PREV_COLS = TB_CURRENT_COLS.map((c) => `${c} (Anterior)`);

/**
 * Arma la jerarquía del plan de cuentas (cuentas título = no postable) a
 * partir de las filas planas de OACT, usando los segmentos del código
 * (ej. "1-1-01" → padre "1-1" → "1"). Cada cuenta título recibe una fila de
 * subtotal con la suma de sus descendientes, y se agrega un total general.
 */
function trialBalanceTree(rows: Record<string, unknown>[], hasPrev: boolean): ReportResult {
  const numCols = hasPrev ? [...TB_CURRENT_COLS, ...TB_PREV_COLS] : TB_CURRENT_COLS;

  interface Node {
    code: string;
    name: string;
    postable: boolean;
    own: Record<string, number>;
    children: Node[];
  }

  const nodes = new Map<string, Node>();
  for (const r of rows) {
    const code = String(r["Cuenta"]);
    const own: Record<string, number> = {};
    for (const c of numCols) own[c] = num(r[c]);
    nodes.set(code, { code, name: String(r["Nombre"] ?? ""), postable: r["_Postable"] === "Y", own, children: [] });
  }

  const parentCode = (code: string): string | null => {
    const i = code.lastIndexOf("-");
    return i > 0 ? code.slice(0, i) : null;
  };

  const roots: Node[] = [];
  for (const node of nodes.values()) {
    let p = parentCode(node.code);
    let parent: Node | undefined;
    while (p) {
      parent = nodes.get(p);
      if (parent) break;
      p = parentCode(p);
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.code.localeCompare(b.code));
  roots.sort((a, b) => a.code.localeCompare(b.code));

  const outRows: Record<string, unknown>[] = [];
  const grandTotal: Record<string, number> = Object.fromEntries(numCols.map((c) => [c, 0]));

  function emit(node: Node): Record<string, number> {
    const subtotal: Record<string, number> = { ...node.own };
    for (const child of node.children) {
      const childTotal = emit(child);
      for (const c of numCols) subtotal[c] = round2(subtotal[c] + childTotal[c]);
    }
    if (node.postable || node.children.length === 0) {
      const row: Record<string, unknown> = { Cuenta: node.code, Nombre: node.name };
      for (const c of numCols) row[c] = round2(node.own[c]);
      outRows.push(row);
    }
    if (node.children.length > 0) {
      const row: Record<string, unknown> = { Cuenta: "", Nombre: `TOTAL ${node.name}` };
      for (const c of numCols) row[c] = subtotal[c];
      outRows.push(row);
    }
    return subtotal;
  }

  for (const root of roots) {
    const t = emit(root);
    for (const c of numCols) grandTotal[c] = round2(grandTotal[c] + t[c]);
  }
  outRows.push({ Cuenta: "", Nombre: "TOTAL GENERAL", ...grandTotal });

  return { rows: outRows, columns: ["Cuenta", "Nombre", ...numCols] };
}

// ------------------------------- Registro -------------------------------

const dateFrom: FilterDef = { key: "dateFrom", label: "Desde", type: "date" };
const dateTo: FilterDef = { key: "dateTo", label: "Hasta", type: "date" };

export const REPORTS: Record<string, ReportDef> = {
  CoaReport: {
    name: "CoaReport",
    label: "Plan de cuentas",
    kind: "journal",
    description: "Catálogo completo de cuentas contables.",
    filters: [{ key: "search", label: "Buscar cuenta", type: "text", placeholder: "código o nombre" }],
    run: chartOfAccounts,
  },
  GeneralLedger: {
    name: "GeneralLedger",
    label: "Auxiliar por cuenta (mayor) — ₡ y $",
    kind: "journal",
    description:
      "Detalle de movimientos por cuenta y fechas, en colones y dólares, con nombre de contrapartida, centro de costo, origen del documento y saldo acumulado. Deje la cuenta vacía para ver todas.",
    filters: [
      {
        key: "account",
        label: "Cuenta contable",
        type: "select",
        source: "ChartOfAccounts",
        placeholder: "vacío = todas",
      },
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
  M."Cuenta", M."Nombre Cuenta", M."Fecha Cont.", M."Fecha Venc.", M."Documento",
  M."Nº Trans.", M."Origen", M."Concepto", M."Contrapartida", M."Nombre Contrap.", M."Centro de Costo",
  M."Débito ₡", M."Crédito ₡",
  COALESCE(M."OpenCol",0) + SUM(M."NetCol") OVER (PARTITION BY M."Cuenta" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo ₡",
  M."Débito $", M."Crédito $",
  COALESCE(M."OpenDol",0) + SUM(M."NetDol") OVER (PARTITION BY M."Cuenta" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo $"
FROM (
  SELECT T1."Account" "Cuenta", A."AcctName" "Nombre Cuenta",
    TO_VARCHAR(T0."RefDate",'DD/MM/YY') "Fecha Cont.",
    TO_VARCHAR(T1."DueDate",'DD/MM/YY') "Fecha Venc.",
    T0."RefDate" "ord",
    T0."TransType" || ' ' || T0."BaseRef" "Documento", T0."TransId" "Nº Trans.", T1."Line_ID" "Line",${ORIGEN_CASE} "Origen",
    CASE WHEN T1."LineMemo" <> '' THEN T1."LineMemo" ELSE T0."Memo" END "Concepto",
    T1."ContraAct" "Contrapartida", AC."AcctName" "Nombre Contrap.",
    T1."ProfitCode" "Centro de Costo",
    T1."Debit" "Débito ₡", T1."Credit" "Crédito ₡", T1."Debit"-T1."Credit" "NetCol",
    T1."SYSDeb" "Débito $", T1."SYSCred" "Crédito $", T1."SYSDeb"-T1."SYSCred" "NetDol",
    op."OpenCol", op."OpenDol"
  FROM OJDT T0
  INNER JOIN JDT1 T1 ON T0."TransId"=T1."TransId"
  LEFT JOIN OACT A ON T1."Account"=A."AcctCode"
  LEFT JOIN OACT AC ON T1."ContraAct"=AC."AcctCode"
  LEFT JOIN ( SELECT X."Account" ac, SUM(X."Debit"-X."Credit") "OpenCol", SUM(X."SYSDeb"-X."SYSCred") "OpenDol"
              FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
              WHERE H."RefDate" < ? AND (? = '' OR X."Account" = ?) GROUP BY X."Account" ) op ON op.ac=T1."Account"
  WHERE T0."RefDate" BETWEEN ? AND ? AND (? = '' OR T1."Account" = ?)
) M
ORDER BY M."Cuenta", M."ord", M."Nº Trans.", M."Line"`,
      params: [f.dateFrom, f.account || "", f.account || "", f.dateFrom, f.dateTo, f.account || "", f.account || ""],
    }),
  },
  MovimientosSAP: {
    name: "MovimientosSAP",
    label: "Movimientos SAP (asientos detallados ₡ y $)",
    kind: "journal",
    description:
      "Todas las líneas de asientos del periodo: cuenta, socio (contrapartida) y débitos/créditos en USD (moneda extranjera) y colones.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    run: movimientosSAP,
  },
  TrialBalance: {
    name: "TrialBalance",
    label: "Balance de comprobación — ₡ y $",
    kind: "journal",
    description:
      "Todas las cuentas con saldo inicial, débitos y créditos del periodo, y saldo final, en colones y dólares — con subtotal por cada cuenta de mayor y total general (igual al Balance de Comprobación de SAP). Permite excluir el asiento de cierre de periodo (antes/después del cierre) y comparar contra un periodo anterior.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
      {
        key: "closingJE",
        label: "Excluir asiento(s) de cierre (Nº Trans., separados por coma)",
        type: "text",
        placeholder: "vacío = incluir el cierre (después del cierre)",
      },
      { key: "dateFromPrev", label: "Desde (periodo anterior, opcional)", type: "date" },
      { key: "dateToPrev", label: "Hasta (periodo anterior, opcional)", type: "date" },
    ],
    sql: (f) => {
      const excl = sanitizeTransIds(f.closingJE);
      const exclSql = excl.length ? ` AND X."TransId" NOT IN (${excl.join(",")})` : "";
      const hasPrev = !!(f.dateFromPrev && f.dateToPrev);

      const prevSelect = hasPrev
        ? `,
  COALESCE(opP."OpenCol",0) AS "Saldo inicial ₡ (Anterior)",
  COALESCE(mvP."DebCol",0)  AS "Débitos ₡ (Anterior)",
  COALESCE(mvP."CredCol",0) AS "Créditos ₡ (Anterior)",
  COALESCE(opP."OpenCol",0) + COALESCE(mvP."DebCol",0) - COALESCE(mvP."CredCol",0) AS "Saldo final ₡ (Anterior)",
  COALESCE(opP."OpenDol",0) AS "Saldo inicial $ (Anterior)",
  COALESCE(mvP."DebDol",0)  AS "Débitos $ (Anterior)",
  COALESCE(mvP."CredDol",0) AS "Créditos $ (Anterior)",
  COALESCE(opP."OpenDol",0) + COALESCE(mvP."DebDol",0) - COALESCE(mvP."CredDol",0) AS "Saldo final $ (Anterior)"`
        : "";

      const prevJoin = hasPrev
        ? `
LEFT JOIN ( SELECT X."Account" ac, SUM(X."Debit"-X."Credit") "OpenCol", SUM(X."SYSDeb"-X."SYSCred") "OpenDol"
            FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
            WHERE H."RefDate" < ?${exclSql} GROUP BY X."Account" ) opP ON opP.ac = A."AcctCode"
LEFT JOIN ( SELECT X."Account" ac,
                   SUM(X."Debit") "DebCol", SUM(X."Credit") "CredCol",
                   SUM(X."SYSDeb") "DebDol", SUM(X."SYSCred") "CredDol"
            FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
            WHERE H."RefDate" BETWEEN ? AND ?${exclSql} GROUP BY X."Account" ) mvP ON mvP.ac = A."AcctCode"`
        : "";

      const params: any[] = [f.dateFrom, f.dateFrom, f.dateTo];
      if (hasPrev) params.push(f.dateFromPrev, f.dateFromPrev, f.dateToPrev);

      return {
        text: `
SELECT
  A."AcctCode" AS "Cuenta",
  A."AcctName" AS "Nombre",
  A."Postable" AS "_Postable",
  COALESCE(op."OpenCol",0) AS "Saldo inicial ₡",
  COALESCE(mv."DebCol",0)  AS "Débitos ₡",
  COALESCE(mv."CredCol",0) AS "Créditos ₡",
  COALESCE(op."OpenCol",0) + COALESCE(mv."DebCol",0) - COALESCE(mv."CredCol",0) AS "Saldo final ₡",
  COALESCE(op."OpenDol",0) AS "Saldo inicial $",
  COALESCE(mv."DebDol",0)  AS "Débitos $",
  COALESCE(mv."CredDol",0) AS "Créditos $",
  COALESCE(op."OpenDol",0) + COALESCE(mv."DebDol",0) - COALESCE(mv."CredDol",0) AS "Saldo final $"${prevSelect}
FROM OACT A
LEFT JOIN ( SELECT X."Account" ac, SUM(X."Debit"-X."Credit") "OpenCol", SUM(X."SYSDeb"-X."SYSCred") "OpenDol"
            FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
            WHERE H."RefDate" < ?${exclSql} GROUP BY X."Account" ) op ON op.ac = A."AcctCode"
LEFT JOIN ( SELECT X."Account" ac,
                   SUM(X."Debit") "DebCol", SUM(X."Credit") "CredCol",
                   SUM(X."SYSDeb") "DebDol", SUM(X."SYSCred") "CredDol"
            FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
            WHERE H."RefDate" BETWEEN ? AND ?${exclSql} GROUP BY X."Account" ) mv ON mv.ac = A."AcctCode"${prevJoin}
ORDER BY A."AcctCode"`,
        params,
      };
    },
    post: (rows, f) => trialBalanceTree(rows, !!(f.dateFromPrev && f.dateToPrev)),
  },
  LibroMayor: {
    name: "LibroMayor",
    label: "Libro mayor por socio (₡ y $)",
    kind: "master",
    description:
      "Movimientos por socio de negocio con saldo inicial del período y saldo acumulado, contrapartida y doble moneda (igual al Libro Mayor de SAP). Deja los socios vacíos para todos.",
    filters: [
      {
        key: "socioDesde",
        label: "Socio desde",
        type: "select",
        source: "BusinessPartners",
        placeholder: "vacío = todos",
      },
      {
        key: "socioHasta",
        label: "Socio hasta",
        type: "select",
        source: "BusinessPartners",
        placeholder: "vacío = todos",
      },
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
  M."Código", M."Cliente", M."Fecha Cont.", M."Fecha Venc.", M."Documento",
  M."Nº Trans.", M."Origen", M."Concepto", M."Cuenta Contrap.", M."Nombre Contrap.",
  M."Administración", M."Cadena De Suplencia", M."Ventas", M."Comercial", M."Mercadeo Estratégico",
  M."Débito ₡", M."Crédito ₡",
  COALESCE(M."OpenCol",0) + SUM(M."NetCol") OVER (PARTITION BY M."Código" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo ₡",
  M."Débito $", M."Crédito $",
  COALESCE(M."OpenDol",0) + SUM(M."NetDol") OVER (PARTITION BY M."Código" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo $"
FROM (
  SELECT T1."ShortName" "Código", C."CardName" "Cliente",
    TO_VARCHAR(T0."RefDate",'DD/MM/YY') "Fecha Cont.",
    TO_VARCHAR(T1."DueDate",'DD/MM/YY') "Fecha Venc.",
    T0."RefDate" "ord",
    T0."TransType" || ' ' || T0."BaseRef" "Documento",
    T0."TransId" "Nº Trans.", T1."Line_ID" "Line",${ORIGEN_CASE} "Origen",
    CASE WHEN T1."LineMemo" <> '' THEN T1."LineMemo" ELSE T0."Memo" END "Concepto",
    T1."ContraAct" "Cuenta Contrap.", A."AcctName" "Nombre Contrap.",
    T1."ProfitCode" "Administración", T1."OcrCode2" "Cadena De Suplencia", T1."OcrCode3" "Ventas", T1."OcrCode4" "Comercial", T1."OcrCode5" "Mercadeo Estratégico",
    T1."Debit" "Débito ₡", T1."Credit" "Crédito ₡", T1."Debit"-T1."Credit" "NetCol",
    T1."SYSDeb" "Débito $", T1."SYSCred" "Crédito $", T1."SYSDeb"-T1."SYSCred" "NetDol",
    op."OpenCol", op."OpenDol"
  FROM OJDT T0
  INNER JOIN JDT1 T1 ON T0."TransId"=T1."TransId"
  INNER JOIN OCRD C ON T1."ShortName"=C."CardCode"
  LEFT JOIN OACT A ON T1."ContraAct"=A."AcctCode"
  LEFT JOIN ( SELECT X."ShortName" cc, SUM(X."Debit"-X."Credit") "OpenCol", SUM(X."SYSDeb"-X."SYSCred") "OpenDol"
              FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
              WHERE H."RefDate" < ? GROUP BY X."ShortName" ) op ON op.cc=T1."ShortName"
  WHERE T0."RefDate" BETWEEN ? AND ? AND T1."ShortName" BETWEEN ? AND ?
) M
ORDER BY M."Código", M."ord", M."Nº Trans.", M."Line"`,
      params: [f.dateFrom, f.dateFrom, f.dateTo, f.socioDesde || "", f.socioHasta || "ZZZZZZZZZZ"],
    }),
  },
  LibroMayorCuenta: {
    name: "LibroMayorCuenta",
    label: "Libro mayor por cuenta (₡ y $)",
    kind: "journal",
    description:
      "Movimientos por cuenta de mayor con saldo inicial del período y saldo acumulado, contrapartida (con nombre de cliente/proveedor cuando aplica), origen del documento, centro de costo y doble moneda. Acota el rango de cuentas para que sea ágil.",
    filters: [
      { key: "cuentaDesde", label: "Cuenta desde", type: "select", source: "ChartOfAccounts" },
      { key: "cuentaHasta", label: "Cuenta hasta", type: "select", source: "ChartOfAccounts" },
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
  M."Cuenta", M."Nombre Cuenta", M."Fecha Cont.", M."Fecha Venc.", M."Documento",
  M."Nº Trans.", M."Origen", M."Concepto", M."Contrapartida", M."Nombre Contrap.",
  M."Administración", M."Nombre Centro de Costo", M."Cadena De Suplencia", M."Ventas", M."Comercial", M."Mercadeo Estratégico",
  M."Débito ₡", M."Crédito ₡",
  COALESCE(M."OpenCol",0) + SUM(M."NetCol") OVER (PARTITION BY M."Cuenta" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo ₡",
  M."Débito $", M."Crédito $",
  COALESCE(M."OpenDol",0) + SUM(M."NetDol") OVER (PARTITION BY M."Cuenta" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo $"
FROM (
  SELECT T1."Account" "Cuenta", A."AcctName" "Nombre Cuenta",
    TO_VARCHAR(T0."RefDate",'DD/MM/YY') "Fecha Cont.",
    TO_VARCHAR(T1."DueDate",'DD/MM/YY') "Fecha Venc.",
    T0."RefDate" "ord",
    T0."TransType" || ' ' || T0."BaseRef" "Documento", T0."TransId" "Nº Trans.", T1."Line_ID" "Line",${ORIGEN_CASE} "Origen",
    CASE WHEN T1."LineMemo" <> '' THEN T1."LineMemo" ELSE T0."Memo" END "Concepto",
    T1."ContraAct" "Contrapartida", COALESCE(AC."AcctName", BP."CardName") "Nombre Contrap.",
    T1."ProfitCode" "Administración", CC."OcrName" "Nombre Centro de Costo",
    T1."OcrCode2" "Cadena De Suplencia", T1."OcrCode3" "Ventas", T1."OcrCode4" "Comercial", T1."OcrCode5" "Mercadeo Estratégico",
    T1."Debit" "Débito ₡", T1."Credit" "Crédito ₡", T1."Debit"-T1."Credit" "NetCol",
    T1."SYSDeb" "Débito $", T1."SYSCred" "Crédito $", T1."SYSDeb"-T1."SYSCred" "NetDol",
    op."OpenCol", op."OpenDol"
  FROM OJDT T0
  INNER JOIN JDT1 T1 ON T0."TransId"=T1."TransId"
  LEFT JOIN OACT A ON T1."Account"=A."AcctCode"
  LEFT JOIN OACT AC ON T1."ContraAct"=AC."AcctCode"
  LEFT JOIN OCRD BP ON T1."ContraAct"=BP."CardCode"
  LEFT JOIN OOCR CC ON T1."ProfitCode"=CC."OcrCode"
  LEFT JOIN ( SELECT X."Account" ac, SUM(X."Debit"-X."Credit") "OpenCol", SUM(X."SYSDeb"-X."SYSCred") "OpenDol"
              FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
              WHERE H."RefDate" < ? GROUP BY X."Account" ) op ON op.ac=T1."Account"
  WHERE T0."RefDate" BETWEEN ? AND ? AND T1."Account" BETWEEN ? AND ?
) M
ORDER BY M."Cuenta", M."ord", M."Nº Trans.", M."Line"`,
      params: [f.dateFrom, f.dateFrom, f.dateTo, f.cuentaDesde || "", f.cuentaHasta || "ZZZZZZZZZZ"],
    }),
  },
  ReporteSugef: {
    name: "ReporteSugef",
    label: "Reporte Sugef",
    kind: "journal",
    description:
      "Transacciones (ingresos de ventas y egresos de compras) con monto ≥ 10.000 en el periodo, con datos de la empresa y del socio para reporte a Sugef.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT T9."CompnyName"  AS "Nombre completo",
       'Jurídica'       AS "Tipo de identificación",
       T9."TaxIdNum"    AS "Número de identificación",
       T9."CompnyAddr"  AS "Dirección detallada",
       T9."E_Mail"      AS "Correo electrónico",
       T9."Phone1"      AS "Número teléfono",
       T0."CardName"    AS "Nombre completo o razón social",
       CASE WHEN T0."LicTradNum" LIKE '3-___-%'
              OR (T0."LicTradNum" NOT LIKE '%-%' AND T0."LicTradNum" LIKE '3%' AND LENGTH(T0."LicTradNum") = 10)
            THEN 'Jurídica' ELSE 'Física' END AS "Tipo de identificación ",
       T0."LicTradNum"  AS "Número de identificación ",
       T2."Street"      AS "Dirección detallada ",
       T4."E_Mail"      AS "Correo electrónico ",
       T4."Phone1"      AS "Número teléfono ",
       'Ingreso'        AS "Tipo de transacción (ingreso o egreso)",
       T0."NumAtCard"   AS "Número de la transacción",
       TO_VARCHAR(T0."DocDate",'DD/MM/YY') AS "Fecha transacción",
       T0."DocTotalSy"  AS "Monto de transacción",
       T0."Comments"    AS "Origen de los fondos (breve descripción)"
FROM OINV T0
INNER JOIN OADM T9 ON 1 = 1
LEFT JOIN CRD1 T2 ON T2."CardCode" = T0."CardCode" AND T2."Address" = T0."PayToCode" AND T2."AdresType" = 'B'
LEFT JOIN OCRD T4 ON T4."CardCode" = T0."CardCode"
WHERE T0."DocTotalSy" >= 10000 AND T0."DocDate" >= ? AND T0."DocDate" <= ? AND T0."CANCELED" = 'N'
UNION ALL
SELECT T1."CardName",
       CASE WHEN T1."LicTradNum" LIKE '3-___-%'
              OR (T1."LicTradNum" NOT LIKE '%-%' AND T1."LicTradNum" LIKE '3%' AND LENGTH(T1."LicTradNum") = 10)
            THEN 'Jurídica' ELSE 'Física' END,
       T1."LicTradNum",
       T3."Street",
       T5."E_Mail",
       T5."Phone1",
       T9."CompnyName",
       'Jurídica',
       T9."TaxIdNum",
       T9."CompnyAddr",
       T9."E_Mail",
       T9."Phone1",
       'Egreso',
       T1."NumAtCard",
       TO_VARCHAR(T1."DocDate",'DD/MM/YY'),
       T1."DocTotalSy",
       T1."Comments"
FROM OPCH T1
INNER JOIN OADM T9 ON 1 = 1
LEFT JOIN CRD1 T3 ON T3."CardCode" = T1."CardCode" AND T3."Address" = T1."PayToCode" AND T3."AdresType" = 'B'
LEFT JOIN OCRD T5 ON T5."CardCode" = T1."CardCode"
WHERE T1."DocTotalSy" >= 10000 AND T1."DocDate" >= ? AND T1."DocDate" <= ? AND T1."CANCELED" = 'N'
ORDER BY 13 DESC, 16 DESC`,
      params: [f.dateFrom, f.dateTo, f.dateFrom, f.dateTo],
    }),
  },
  VentasPorLineaCC: {
    name: "VentasPorLineaCC",
    label: "VENTAS POR LINEA Y CC",
    kind: "salesDoc",
    description:
      "Facturas y notas de crédito de cliente por línea, con artículo, grupo de socio, centro de costo, impuesto y cuenta, en colones y dólares, por rango de fechas.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT 'Factura' AS "Tipo Documento", T0."DocEntry", TO_VARCHAR(T0."DocDate",'DD/MM/YY') AS "DocDate", T0."NumAtCard", T0."CardName",
       T3."GroupCode", T4."GroupName", T1."OcrCode", T5."OcrName", T1."TaxCode", T1."VatPrcnt" AS "% Impuesto",
       T1."LineTotal" AS "Monto Bruto Col", T1."VatSum" AS "Impuesto Col", (T1."LineTotal"+T1."VatSum") AS "Total Col",
       T1."TotalSumSy" AS "Monto Bruto Dol", T1."VatSumSy" AS "Impuesto Dol", (T1."TotalSumSy"+T1."VatSumSy") AS "Total Dol",
       T1."ItemCode" AS "Código Artículo", T6."ItemName" AS "Nombre Artículo", T1."Dscription", T0."JrnlMemo", T1."AcctCode", T2."AcctName"
FROM OINV T0
INNER JOIN INV1 T1 ON T0."DocEntry" = T1."DocEntry"
INNER JOIN OACT T2 ON T1."AcctCode" = T2."AcctCode"
INNER JOIN OCRD T3 ON T0."CardCode" = T3."CardCode"
INNER JOIN OCRG T4 ON T3."GroupCode" = T4."GroupCode"
INNER JOIN OOCR T5 ON T1."OcrCode" = T5."OcrCode"
LEFT JOIN OITM T6 ON T1."ItemCode" = T6."ItemCode"
WHERE T0."DocDate" >= ? AND T0."DocDate" <= ? AND T0."CANCELED" = 'N' AND (T0."DocSubType" <> 'DN' OR T0."DocSubType" IS NULL)
UNION ALL
SELECT 'Nota de Crédito', T0."DocEntry", TO_VARCHAR(T0."DocDate",'DD/MM/YY'), T0."NumAtCard", T0."CardName",
       T3."GroupCode", T4."GroupName", T1."OcrCode", T5."OcrName", T1."TaxCode", T1."VatPrcnt"*-1,
       T1."LineTotal"*-1, T1."VatSum"*-1, (T1."LineTotal"+T1."VatSum")*-1,
       T1."TotalSumSy"*-1, T1."VatSumSy"*-1, (T1."TotalSumSy"+T1."VatSumSy")*-1,
       T1."ItemCode", T6."ItemName", T1."Dscription", T0."JrnlMemo", T1."AcctCode", T2."AcctName"
FROM ORIN T0
INNER JOIN RIN1 T1 ON T0."DocEntry" = T1."DocEntry"
INNER JOIN OACT T2 ON T1."AcctCode" = T2."AcctCode"
INNER JOIN OCRD T3 ON T0."CardCode" = T3."CardCode"
INNER JOIN OCRG T4 ON T3."GroupCode" = T4."GroupCode"
INNER JOIN OOCR T5 ON T1."OcrCode" = T5."OcrCode"
LEFT JOIN OITM T6 ON T1."ItemCode" = T6."ItemCode"
WHERE T0."DocDate" >= ? AND T0."DocDate" <= ? AND T0."CANCELED" = 'N'`,
      params: [f.dateFrom, f.dateTo, f.dateFrom, f.dateTo],
    }),
  },
  LibroVentas: {
    name: "LibroVentas",
    label: "Libro de ventas",
    kind: "salesDoc",
    description:
      "Detalle por línea de facturas, notas de débito y notas de crédito de cliente (con grupo de socio, centro de costo, impuesto y cuenta), en colones y dólares, por rango de fechas.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT T0."DocEntry", TO_VARCHAR(T0."DocDate",'DD/MM/YY') AS "DocDate", T0."NumAtCard", T0."CardName",
       CASE WHEN T0."CorrectionInvoice"='Y' THEN 'Nota de Débito' ELSE 'Factura' END AS "Tipo Documento",
       T3."GroupCode", T4."GroupName", T1."OcrCode", T5."OcrName", T1."TaxCode",
       T1."VatPrcnt" AS "% Impuesto",
       T1."LineTotal" AS "Monto Bruto Col", T1."VatSum" AS "Impuesto Col", (T1."LineTotal"+T1."VatSum") AS "Total Col",
       T1."TotalSumSy" AS "Monto Bruto Dol", T1."VatSumSy" AS "Impuesto Dol", (T1."TotalSumSy"+T1."VatSumSy") AS "Total Dol",
       T1."Dscription", T0."JrnlMemo", T1."AcctCode", T2."AcctName"
FROM OINV T0
INNER JOIN INV1 T1 ON T0."DocEntry"=T1."DocEntry"
INNER JOIN OACT T2 ON T1."AcctCode"=T2."AcctCode"
INNER JOIN OCRD T3 ON T0."CardCode"=T3."CardCode"
INNER JOIN OCRG T4 ON T3."GroupCode"=T4."GroupCode"
INNER JOIN OOCR T5 ON T1."OcrCode"=T5."OcrCode"
WHERE T0."DocDate" >= ? AND T0."DocDate" <= ? AND T0."CANCELED"='N'
UNION ALL
SELECT T0."DocEntry", TO_VARCHAR(T0."DocDate",'DD/MM/YY'), T0."NumAtCard", T0."CardName",
       'Nota de Crédito',
       T3."GroupCode", T4."GroupName", T1."OcrCode", T5."OcrName", T1."TaxCode",
       T1."VatPrcnt"*-1, T1."LineTotal"*-1, T1."VatSum"*-1, (T1."LineTotal"+T1."VatSum")*-1,
       T1."TotalSumSy"*-1, T1."VatSumSy"*-1, (T1."TotalSumSy"+T1."VatSumSy")*-1,
       T1."Dscription", T0."JrnlMemo", T1."AcctCode", T2."AcctName"
FROM ORIN T0
INNER JOIN RIN1 T1 ON T0."DocEntry"=T1."DocEntry"
INNER JOIN OACT T2 ON T1."AcctCode"=T2."AcctCode"
INNER JOIN OCRD T3 ON T0."CardCode"=T3."CardCode"
INNER JOIN OCRG T4 ON T3."GroupCode"=T4."GroupCode"
INNER JOIN OOCR T5 ON T1."OcrCode"=T5."OcrCode"
WHERE T0."DocDate" >= ? AND T0."DocDate" <= ? AND T0."CANCELED"='N'`,
      params: [f.dateFrom, f.dateTo, f.dateFrom, f.dateTo],
    }),
  },
  CentroCostoGeneral: {
    name: "CentroCostoGeneral",
    label: "Reporte por centro de costo (General)",
    kind: "journal",
    description:
      "Movimientos de asientos de cuentas de gasto (6-…) con las dimensiones de centro de costo, en colones y dólares, por rango de fechas.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
    T0."TransId",
    TO_VARCHAR(T1."RefDate",'DD/MM/YY') AS "Fecha",
    T1."LineMemo",
    T1."Ref3Line" AS "Proveedor",
    T1."Account",
    T2."AcctName",
    T1."Debit" - T1."Credit" AS "Colones",
    T1."SYSDeb" - T1."SYSCred" AS "Dolares",
    T1."ProfitCode" AS "Administración",
    CC."OcrName" AS "Nombre Centro de Costo",
    T1."OcrCode2" AS "Cadena De Suplencia",
    T1."OcrCode3" AS "Ventas",
    T1."OcrCode4" AS "Comercial",
    T1."OcrCode5" AS "Mercadeo Estratégico",
    T1."Ref1" AS "Ref1",
    T1."Ref2" AS "Ref2",
    T1."Ref3Line" AS "Ref3"
FROM OJDT T0
INNER JOIN JDT1 T1 ON T0."TransId" = T1."TransId"
INNER JOIN OACT T2 ON T1."Account" = T2."AcctCode"
LEFT JOIN OOCR CC ON T1."ProfitCode" = CC."OcrCode"
WHERE T0."RefDate" >= ? AND T0."RefDate" <= ? AND T1."Account" LIKE '6-%'`,
      params: [f.dateFrom, f.dateTo],
    }),
  },
  GastosMensual: {
    name: "GastosMensual",
    label: "Reporte de gastos mensual",
    kind: "journal",
    description:
      "Total de gastos (cuentas 6-…) por mes y por cuenta, en colones y dólares, por rango de fechas.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
  TO_VARCHAR(T1."RefDate",'YYYY-MM') AS "Mes",
  T1."Account" AS "Cuenta",
  T2."AcctName" AS "Nombre Cuenta",
  SUM(T1."Debit" - T1."Credit") AS "Total ₡",
  SUM(T1."SYSDeb" - T1."SYSCred") AS "Total $"
FROM OJDT T0
INNER JOIN JDT1 T1 ON T0."TransId" = T1."TransId"
INNER JOIN OACT T2 ON T1."Account" = T2."AcctCode"
WHERE T0."RefDate" >= ? AND T0."RefDate" <= ? AND T1."Account" LIKE '6-%'
GROUP BY TO_VARCHAR(T1."RefDate",'YYYY-MM'), T1."Account", T2."AcctName"
ORDER BY "Mes", "Cuenta"`,
      params: [f.dateFrom, f.dateTo],
    }),
  },
  IngresosMensual: {
    name: "IngresosMensual",
    label: "Reporte de ingresos mensual",
    kind: "journal",
    description:
      "Total de ingresos (cuentas 4-…) por mes y por cuenta, en colones y dólares, por rango de fechas.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
  TO_VARCHAR(T1."RefDate",'YYYY-MM') AS "Mes",
  T1."Account" AS "Cuenta",
  T2."AcctName" AS "Nombre Cuenta",
  SUM(T1."Credit" - T1."Debit") AS "Total ₡",
  SUM(T1."SYSCred" - T1."SYSDeb") AS "Total $"
FROM OJDT T0
INNER JOIN JDT1 T1 ON T0."TransId" = T1."TransId"
INNER JOIN OACT T2 ON T1."Account" = T2."AcctCode"
WHERE T0."RefDate" >= ? AND T0."RefDate" <= ? AND T1."Account" LIKE '4-%'
GROUP BY TO_VARCHAR(T1."RefDate",'YYYY-MM'), T1."Account", T2."AcctName"
ORDER BY "Mes", "Cuenta"`,
      params: [f.dateFrom, f.dateTo],
    }),
  },
  LibroCompras: {
    name: "LibroCompras",
    label: "Libro de compras",
    kind: "purchaseDoc",
    description:
      "Detalle por línea de facturas, notas de débito y notas de crédito de proveedor (con grupo de socio, centro de costo, impuesto y cuenta), en colones y dólares, por rango de fechas.",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT T0."DocEntry", TO_VARCHAR(T0."DocDate",'DD/MM/YY') AS "DocDate", T0."NumAtCard", T0."CardName",
       CASE WHEN T0."CorrectionInvoice"='Y' THEN 'Nota de Débito' ELSE 'Factura' END AS "Tipo Documento",
       T3."GroupCode", T4."GroupName", T1."OcrCode", T5."OcrName", T1."TaxCode",
       T1."VatPrcnt" AS "% Impuesto",
       T1."LineTotal" AS "Monto Bruto Col", T1."VatSum" AS "Impuesto Col", (T1."LineTotal"+T1."VatSum") AS "Total Col",
       T1."TotalSumSy" AS "Monto Bruto Dol", T1."VatSumSy" AS "Impuesto Dol", (T1."TotalSumSy"+T1."VatSumSy") AS "Total Dol",
       T1."Dscription", T0."JrnlMemo", T1."AcctCode", T2."AcctName"
FROM OPCH T0
INNER JOIN PCH1 T1 ON T0."DocEntry"=T1."DocEntry"
INNER JOIN OACT T2 ON T1."AcctCode"=T2."AcctCode"
INNER JOIN OCRD T3 ON T0."CardCode"=T3."CardCode"
INNER JOIN OCRG T4 ON T3."GroupCode"=T4."GroupCode"
INNER JOIN OOCR T5 ON T1."OcrCode"=T5."OcrCode"
WHERE T0."DocDate" >= ? AND T0."DocDate" <= ? AND T0."CANCELED"='N'
UNION ALL
SELECT T0."DocEntry", TO_VARCHAR(T0."DocDate",'DD/MM/YY'), T0."NumAtCard", T0."CardName",
       'Nota de Crédito',
       T3."GroupCode", T4."GroupName", T1."OcrCode", T5."OcrName", T1."TaxCode",
       T1."VatPrcnt"*-1, T1."LineTotal"*-1, T1."VatSum"*-1, (T1."LineTotal"+T1."VatSum")*-1,
       T1."TotalSumSy"*-1, T1."VatSumSy"*-1, (T1."TotalSumSy"+T1."VatSumSy")*-1,
       T1."Dscription", T0."JrnlMemo", T1."AcctCode", T2."AcctName"
FROM ORPC T0
INNER JOIN RPC1 T1 ON T0."DocEntry"=T1."DocEntry"
INNER JOIN OACT T2 ON T1."AcctCode"=T2."AcctCode"
INNER JOIN OCRD T3 ON T0."CardCode"=T3."CardCode"
INNER JOIN OCRG T4 ON T3."GroupCode"=T4."GroupCode"
INNER JOIN OOCR T5 ON T1."OcrCode"=T5."OcrCode"
WHERE T0."DocDate" >= ? AND T0."DocDate" <= ? AND T0."CANCELED"='N'`,
      params: [f.dateFrom, f.dateTo, f.dateFrom, f.dateTo],
    }),
  },
  FlujoCaja: {
    name: "FlujoCaja",
    label: "Flujo de caja",
    kind: "payment",
    description: "Flujo de caja del periodo (procedimiento BMT_FLUJO_CAJA en HANA).",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    // El SP espera fechas en formato YYYYMMDD (p.ej. '20250501').
    sql: (f) => ({
      text: "CALL BMT_FLUJO_CAJA(?, ?)",
      params: [(f.dateFrom || "").replace(/-/g, ""), (f.dateTo || "").replace(/-/g, "")],
    }),
    // El SP devuelve la fecha de pago como TIMESTAMP (con hora en 00:00:00);
    // se recorta a solo fecha para que no se vea la hora en el Excel.
    post: (rows) => stripTimeOfDay(rows),
  },
  AntiguedadCxC: {
    name: "AntiguedadCxC",
    label: "Antigüedad cuentas por cobrar (₡ y $)",
    kind: "master",
    description:
      "Detalle por factura de cliente con saldo pendiente: fecha de emisión, fecha de vencimiento, días vencidos y pendiente, en colones o dólares (SQL directo a HANA).",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
      {
        key: "moneda",
        label: "Moneda",
        type: "select",
        options: [
          { value: "", label: "Ambas" },
          { value: "CRC", label: "Colones" },
          { value: "USD", label: "Dólares" },
        ],
      },
    ],
    sql: (f) => {
      const monedaSql =
        f.moneda === "USD" ? ` AND M."Moneda" = 'USD'` : f.moneda === "CRC" ? ` AND M."Moneda" <> 'USD'` : "";
      return {
        text: `
SELECT
  M."Código", M."Cliente", M."Documento", M."Moneda",
  M."Fecha Emisión", M."Fecha Vencimiento", M."Días Vencidos",
  M."Monto Original", M."Pendiente"
FROM (
  SELECT
    T0."CardCode" AS "Código", T0."CardName" AS "Cliente", T0."DocNum" AS "Documento",
    T0."DocCur" AS "Moneda",
    TO_VARCHAR(T0."DocDate",'DD/MM/YY') AS "Fecha Emisión",
    TO_VARCHAR(T0."DocDueDate",'DD/MM/YY') AS "Fecha Vencimiento",
    T0."DocDueDate" AS "ord",
    CASE WHEN CURRENT_DATE > T0."DocDueDate" THEN DAYS_BETWEEN(T0."DocDueDate", CURRENT_DATE) ELSE 0 END AS "Días Vencidos",
    CASE WHEN T0."DocCur" = 'USD' THEN T0."DocTotalFC" ELSE T0."DocTotal" END AS "Monto Original",
    CASE WHEN T0."DocCur" = 'USD' THEN (T0."DocTotalFC" - T0."PaidFC") ELSE (T0."DocTotal" - T0."PaidToDate") END AS "Pendiente"
  FROM OINV T0
  WHERE T0."CANCELED" = 'N' AND T0."DocDate" >= ? AND T0."DocDate" <= ?
) M
WHERE M."Pendiente" > 0.01${monedaSql}
ORDER BY M."Código", M."ord"`,
        params: [f.dateFrom, f.dateTo],
      };
    },
  },
  EstadoObligaciones: {
    name: "EstadoObligaciones",
    label: "Estado de obligaciones (cuentas por pagar)",
    kind: "purchaseDoc",
    description:
      "Facturas de compra abiertas + pagos/adelantos a cuenta, con total y pendiente en colones y dólares, por centro de costo (SQL directo a HANA).",
    filters: [
      { key: "cardCode", label: "Proveedor (CardCode)", type: "text", placeholder: "opcional" },
      dateFrom,
      dateTo,
    ],
    sql: (f) => {
      const opch = [`T0."DocStatus" <> 'C'`];
      const ovpm = [`T99."Canceled" = 'N'`, `T99."OpenBal" > 0`];
      const params: any[] = [];
      // Mismos filtros en ambas partes del UNION (en el mismo orden que aparecen).
      if (f.cardCode) opch.push(`T0."CardCode" = ?`);
      if (f.dateFrom) opch.push(`T0."DocDate" >= ?`);
      if (f.dateTo) opch.push(`T0."DocDate" <= ?`);
      if (f.cardCode) params.push(f.cardCode);
      if (f.dateFrom) params.push(f.dateFrom);
      if (f.dateTo) params.push(f.dateTo);
      if (f.cardCode) ovpm.push(`T99."CardCode" = ?`);
      if (f.dateFrom) ovpm.push(`T99."DocDate" >= ?`);
      if (f.dateTo) ovpm.push(`T99."DocDate" <= ?`);
      if (f.cardCode) params.push(f.cardCode);
      if (f.dateFrom) params.push(f.dateFrom);
      if (f.dateTo) params.push(f.dateTo);
      const text = `
SELECT DISTINCT
  T0."DocEntry" AS "DocEntry",
  T0."DocNum" AS "# Documento",
  T0."Comments" AS "Detalle",
  T0."CardCode" AS "Codigo Proveedor",
  T0."CardName" AS "Nombre Proveedor",
  TO_VARCHAR(T0."DocDueDate",'DD/MM/YY') AS "Fecha Vencimiento",
  T0."DocCur" AS "Moneda",
  T0."NumAtCard" AS "Documento",
  CASE WHEN T0."DocCur"='USD' THEN 0 WHEN T0."DocCur"='COL' THEN T0."DocTotal"*-1 END AS "Total Colones",
  CASE WHEN T0."DocCur"='USD' THEN T0."DocTotalFC"*-1 WHEN T0."DocCur"='COL' THEN 0 END AS "Total Dólares",
  CASE WHEN T0."DocCur"='USD' THEN 0 WHEN T0."DocCur"='COL' THEN (T0."DocTotal"-T0."PaidToDate")*-1 END AS "Pendiente Colones",
  CASE WHEN T0."DocCur"='USD' THEN (T0."DocTotalSy"-T0."PaidSys")*-1 WHEN T0."DocCur"='COL' THEN 0 END AS "Pendiente Dólares",
  T2."OcrName" AS "Centro Costo",
  'Factura' AS "Tipo Documento"
FROM OPCH T0
INNER JOIN PCH1 T1 ON T0."DocEntry"=T1."DocEntry"
INNER JOIN OOCR T2 ON T1."OcrCode"=T2."OcrCode"
WHERE ${opch.join(" AND ")}
UNION ALL
SELECT
  T99."DocEntry",
  T99."DocNum",
  T99."Comments",
  T99."CardCode",
  T99."CardName",
  TO_VARCHAR(T99."DocDueDate",'DD/MM/YY'),
  T99."DocCurr",
  '',
  CASE WHEN T99."DocCurr"='USD' THEN 0 WHEN T99."DocCurr"='COL' THEN T99."DocTotal" END,
  CASE WHEN T99."DocCurr"='USD' THEN T99."DocTotalFC" WHEN T99."DocCurr"='COL' THEN 0 END,
  0,
  0,
  '',
  'Pago'
FROM OVPM T99
WHERE ${ovpm.join(" AND ")}
ORDER BY "Codigo Proveedor"`;
      return { text, params };
    },
  },
  PartnerAging: {
    name: "PartnerAging",
    label: "Saldos y antigüedad de socios",
    kind: "master",
    description: "Antigüedad de saldos por socio a partir de facturas abiertas.",
    filters: [
      {
        key: "cardType",
        label: "Tipo de socio",
        type: "select",
        options: [
          { value: "cCustomer", label: "Clientes" },
          { value: "cSupplier", label: "Proveedores" },
        ],
      },
      { key: "asOfDate", label: "A la fecha", type: "date" },
    ],
    run: partnerAging,
  },
};

export function getReport(name: string): ReportDef | undefined {
  return REPORTS[name];
}
