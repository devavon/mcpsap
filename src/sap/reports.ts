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
  options?: { value: string; label: string }[];
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
  kind: "journal" | "payment" | "master";
  description: string;
  filters: FilterDef[];
  run: (client: ServiceLayerClient, f: Record<string, string>) => Promise<ReportResult>;
}

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? 0)) || 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

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
  // Sin $select: trae TODOS los campos de la cuenta.
  const q =
    (filters.length ? `$filter=${encodeURIComponent(filters.join(" and "))}&` : "") + `$orderby=Code`;
  const rows = await client.getAll<Record<string, unknown>>("ChartOfAccounts", q);
  // Columnas clave primero; el resto se añade en orden natural en el cliente.
  return { rows, columns: orderColumns(rows, ["Code", "Name", "AccountType", "ActiveAccount", "AccountLevel"]) };
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

// ----------------------- Mayor / Libro mayor -----------------------

async function generalLedger(client: ServiceLayerClient, f: Record<string, string>): Promise<ReportResult> {
  const acct = (f.account || "").trim();
  const [jes, names] = await Promise.all([fetchJournal(client, f.dateFrom, f.dateTo), accountNames(client)]);

  const rows: Record<string, unknown>[] = [];
  for (const je of jes) {
    for (const l of je.JournalEntryLines ?? []) {
      if (acct && l.AccountCode !== acct) continue;
      rows.push({
        Fecha: je.ReferenceDate,
        Asiento: je.JdtNum,
        Cuenta: l.AccountCode,
        Nombre: names.get(l.AccountCode ?? "") ?? l.ShortName ?? "",
        Contrapartida: l.ContraAccount,
        Vence: l.DueDate ?? null,
        "Débito ₡": round2(num(l.Debit)),
        "Crédito ₡": round2(num(l.Credit)),
        "Débito $": round2(num(l.DebitSys)),
        "Crédito $": round2(num(l.CreditSys)),
        Memo: l.LineMemo ?? je.Memo,
        Referencia: l.Reference1 ?? je.Reference,
      });
    }
  }

  const cols = [
    "Fecha", "Asiento", "Cuenta", "Nombre", "Contrapartida", "Vence",
    "Débito ₡", "Crédito ₡", "Débito $", "Crédito $",
  ];

  // Si se filtró por una sola cuenta, agrega saldo acumulado en ambas monedas.
  if (acct) {
    let sC = 0, sD = 0;
    for (const r of rows) {
      sC += (r["Débito ₡"] as number) - (r["Crédito ₡"] as number);
      sD += (r["Débito $"] as number) - (r["Crédito $"] as number);
      r["Saldo ₡"] = round2(sC);
      r["Saldo $"] = round2(sD);
    }
    cols.push("Saldo ₡", "Saldo $");
  }
  cols.push("Memo", "Referencia");

  return { rows, columns: cols };
}

// ----------------------- Balance de comprobación -----------------------

async function trialBalance(client: ServiceLayerClient, f: Record<string, string>): Promise<ReportResult> {
  const [jes, names] = await Promise.all([fetchJournal(client, f.dateFrom, f.dateTo), accountNames(client)]);

  const acc = new Map<string, { dC: number; cC: number; dD: number; cD: number }>();
  for (const je of jes) {
    for (const l of je.JournalEntryLines ?? []) {
      const code = l.AccountCode ?? "(sin cuenta)";
      const a = acc.get(code) ?? { dC: 0, cC: 0, dD: 0, cD: 0 };
      a.dC += num(l.Debit);
      a.cC += num(l.Credit);
      a.dD += num(l.DebitSys);
      a.cD += num(l.CreditSys);
      acc.set(code, a);
    }
  }

  const rows: Record<string, unknown>[] = [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, a]) => ({
      Cuenta: code,
      Nombre: names.get(code) ?? "",
      "Débito ₡": round2(a.dC),
      "Crédito ₡": round2(a.cC),
      "Saldo ₡": round2(a.dC - a.cC),
      "Débito $": round2(a.dD),
      "Crédito $": round2(a.cD),
      "Saldo $": round2(a.dD - a.cD),
    }));

  // Fila de totales (debe cuadrar a 0 en cada moneda).
  const sum = (k: string) => round2(rows.reduce((s, r) => s + (r[k] as number), 0));
  rows.push({
    Cuenta: "", Nombre: "TOTAL",
    "Débito ₡": sum("Débito ₡"), "Crédito ₡": sum("Crédito ₡"), "Saldo ₡": sum("Saldo ₡"),
    "Débito $": sum("Débito $"), "Crédito $": sum("Crédito $"), "Saldo $": sum("Saldo $"),
  });

  return {
    rows,
    columns: ["Cuenta", "Nombre", "Débito ₡", "Crédito ₡", "Saldo ₡", "Débito $", "Crédito $", "Saldo $"],
  };
}

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
      "Detalle de movimientos por cuenta y fechas, en colones y dólares, con contrapartida, vencimiento y saldo acumulado. Deje la cuenta vacía para ver todas.",
    filters: [
      { key: "account", label: "Cuenta contable (Code)", type: "text", placeholder: "ej. 1-1-01 (vacío = todas)" },
      dateFrom,
      dateTo,
    ],
    run: generalLedger,
  },
  TrialBalance: {
    name: "TrialBalance",
    label: "Balance de comprobación — ₡ y $",
    kind: "journal",
    description: "Débitos, créditos y saldo por cuenta en el periodo, en colones y dólares (calculado de los asientos).",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    run: trialBalance,
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
