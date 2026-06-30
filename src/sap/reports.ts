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
        "Entrada USD": num(l.FCDebit) > 0 ? round2(num(l.FCDebit)) : 0,
        "Salida USD": num(l.FCCredit) > 0 ? round2(num(l.FCCredit)) : 0,
        "Entrada COL": num(l.Debit) > 0 ? round2(num(l.Debit)) : 0,
        "Salida COL": num(l.Credit) > 0 ? round2(num(l.Credit)) : 0,
      });
    }
  }

  return {
    rows,
    columns: [
      "FechaSAP", "Documento", "Concepto", "Cuenta", "NombreCuenta",
      "CodigoSocio", "NombreSocio", "Referencia1", "Referencia2", "Referencia3",
      "Entrada USD", "Salida USD", "Entrada COL", "Salida COL",
    ],
  };
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
  MovimientosSAP: {
    name: "MovimientosSAP",
    label: "Movimientos SAP (asientos detallados ₡ y $)",
    kind: "journal",
    description:
      "Todas las líneas de asientos del periodo: cuenta, socio (contrapartida) y entradas/salidas en USD (moneda extranjera) y colones.",
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
    description: "Débitos, créditos y saldo por cuenta en el periodo, en colones y dólares (calculado de los asientos).",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    run: trialBalance,
  },
  LibroMayor: {
    name: "LibroMayor",
    label: "Libro mayor por socio (₡ y $)",
    kind: "master",
    description:
      "Movimientos por socio de negocio con saldo inicial del período y saldo acumulado, contrapartida y doble moneda (igual al Libro Mayor de SAP). Deja los socios vacíos para todos.",
    filters: [
      { key: "socioDesde", label: "Socio desde", type: "text", placeholder: "vacío = todos" },
      { key: "socioHasta", label: "Socio hasta", type: "text", placeholder: "vacío = todos" },
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
  M."Código", M."Cliente", M."Fecha Cont.", M."Fecha Venc.", M."Documento",
  M."Nº Trans.", M."Concepto", M."Cuenta Contrap.", M."Nombre Contrap.",
  M."Débito ₡", M."Crédito ₡",
  COALESCE(M."OpenCol",0) + SUM(M."NetCol") OVER (PARTITION BY M."Código" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo ₡",
  M."Débito $", M."Crédito $",
  COALESCE(M."OpenDol",0) + SUM(M."NetDol") OVER (PARTITION BY M."Código" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo $"
FROM (
  SELECT T1."ShortName" "Código", C."CardName" "Cliente",
    TO_VARCHAR(T0."RefDate",'YYYY-MM-DD') "Fecha Cont.",
    TO_VARCHAR(T1."DueDate",'YYYY-MM-DD') "Fecha Venc.",
    T0."RefDate" "ord",
    T0."TransType" || ' ' || T0."BaseRef" "Documento",
    T0."TransId" "Nº Trans.", T1."Line_ID" "Line",
    CASE WHEN T1."LineMemo" <> '' THEN T1."LineMemo" ELSE T0."Memo" END "Concepto",
    T1."ContraAct" "Cuenta Contrap.", A."AcctName" "Nombre Contrap.",
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
      "Movimientos por cuenta de mayor con saldo inicial del período y saldo acumulado, contrapartida y doble moneda. Acota el rango de cuentas para que sea ágil.",
    filters: [
      { key: "cuentaDesde", label: "Cuenta desde", type: "text", placeholder: "ej. 1-1-01" },
      { key: "cuentaHasta", label: "Cuenta hasta", type: "text", placeholder: "ej. 1-1-99" },
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
  M."Cuenta", M."Nombre Cuenta", M."Fecha Cont.", M."Fecha Venc.", M."Documento",
  M."Nº Trans.", M."Concepto", M."Contrapartida", M."Nombre Contrap.",
  M."Débito ₡", M."Crédito ₡",
  COALESCE(M."OpenCol",0) + SUM(M."NetCol") OVER (PARTITION BY M."Cuenta" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo ₡",
  M."Débito $", M."Crédito $",
  COALESCE(M."OpenDol",0) + SUM(M."NetDol") OVER (PARTITION BY M."Cuenta" ORDER BY M."ord", M."Nº Trans.", M."Line" ROWS UNBOUNDED PRECEDING) AS "Saldo $"
FROM (
  SELECT T1."Account" "Cuenta", A."AcctName" "Nombre Cuenta",
    TO_VARCHAR(T0."RefDate",'YYYY-MM-DD') "Fecha Cont.",
    TO_VARCHAR(T1."DueDate",'YYYY-MM-DD') "Fecha Venc.",
    T0."RefDate" "ord",
    T0."TransType" || ' ' || T0."BaseRef" "Documento", T0."TransId" "Nº Trans.", T1."Line_ID" "Line",
    CASE WHEN T1."LineMemo" <> '' THEN T1."LineMemo" ELSE T0."Memo" END "Concepto",
    T1."ContraAct" "Contrapartida", AC."AcctName" "Nombre Contrap.",
    T1."Debit" "Débito ₡", T1."Credit" "Crédito ₡", T1."Debit"-T1."Credit" "NetCol",
    T1."SYSDeb" "Débito $", T1."SYSCred" "Crédito $", T1."SYSDeb"-T1."SYSCred" "NetDol",
    op."OpenCol", op."OpenDol"
  FROM OJDT T0
  INNER JOIN JDT1 T1 ON T0."TransId"=T1."TransId"
  LEFT JOIN OACT A ON T1."Account"=A."AcctCode"
  LEFT JOIN OACT AC ON T1."ContraAct"=AC."AcctCode"
  LEFT JOIN ( SELECT X."Account" ac, SUM(X."Debit"-X."Credit") "OpenCol", SUM(X."SYSDeb"-X."SYSCred") "OpenDol"
              FROM OJDT H INNER JOIN JDT1 X ON H."TransId"=X."TransId"
              WHERE H."RefDate" < ? GROUP BY X."Account" ) op ON op.ac=T1."Account"
  WHERE T0."RefDate" BETWEEN ? AND ? AND T1."Account" BETWEEN ? AND ?
) M
ORDER BY M."Cuenta", M."ord", M."Nº Trans.", M."Line"`,
      params: [f.dateFrom, f.dateFrom, f.dateTo, f.cuentaDesde || "", f.cuentaHasta || "ZZZZZZZZZZ"],
    }),
  },
  AntiguedadCxC: {
    name: "AntiguedadCxC",
    label: "Antigüedad cuentas por cobrar (₡ y $)",
    kind: "master",
    description:
      "Por cliente: facturas, notas de crédito, pagos/adelantos y pendiente, en colones y dólares (SQL directo a HANA).",
    filters: [
      { ...dateFrom, required: true },
      { ...dateTo, required: true },
    ],
    sql: (f) => ({
      text: `
SELECT
    X."CardCode"                                                       AS "Código",
    O."CardName"                                                       AS "Cliente",
    SUM(CASE WHEN X."Tipo" = 'Factura'       THEN  X."OrigUSD" END)    AS "Fact DOL.",
    SUM(CASE WHEN X."Tipo" = 'Nota Crédito'  THEN -X."OrigUSD" END)    AS "NC DOL.",
    SUM(CASE WHEN X."Tipo" = 'Pago/Adelanto' THEN -X."OrigUSD" END)    AS "Pago DOL.",
    SUM(X."PendUSD")                                                   AS "Pend. DOL.",
    SUM(CASE WHEN X."Tipo" = 'Factura'       THEN  X."OrigCRC" END)    AS "Fact CRC",
    SUM(CASE WHEN X."Tipo" = 'Nota Crédito'  THEN -X."OrigCRC" END)    AS "NC CRC",
    SUM(CASE WHEN X."Tipo" = 'Pago/Adelanto' THEN -X."OrigCRC" END)    AS "Pago CRC",
    SUM(X."PendCRC")                                                   AS "Pend. CRC"
FROM (
        SELECT
            T0."CardCode", T0."CardName", 'Factura' AS "Tipo",
            T0."DocDate" AS "Fecha",
            CASE WHEN T0."DocCur" = 'USD' THEN NULL ELSE T0."DocTotal" END                       AS "OrigCRC",
            CASE WHEN T0."DocCur" = 'USD' THEN T0."DocTotalFC" ELSE NULL END                     AS "OrigUSD",
            CASE WHEN T0."DocCur" = 'USD' THEN NULL ELSE (T0."DocTotal" - T0."PaidToDate") END   AS "PendCRC",
            CASE WHEN T0."DocCur" = 'USD' THEN (T0."DocTotalFC" - T0."PaidFC") ELSE NULL END     AS "PendUSD"
        FROM OINV T0
        WHERE T0."CANCELED" = 'N'
        UNION ALL
        SELECT
            T1."CardCode", T1."CardName", 'Nota Crédito',
            T1."DocDate",
            CASE WHEN T1."DocCur" = 'USD' THEN NULL ELSE -1 * T1."DocTotal" END,
            CASE WHEN T1."DocCur" = 'USD' THEN -1 * T1."DocTotalFC" ELSE NULL END,
            CASE WHEN T1."DocCur" = 'USD' THEN NULL ELSE -1 * (T1."DocTotal" - T1."PaidToDate") END,
            CASE WHEN T1."DocCur" = 'USD' THEN -1 * (T1."DocTotalFC" - T1."PaidFC") ELSE NULL END
        FROM ORIN T1
        WHERE T1."CANCELED" = 'N'
        UNION ALL
        SELECT
            T2."CardCode", T2."CardName", 'Pago/Adelanto',
            T2."DocDate",
            CASE WHEN T3."FCCurrency" = 'USD' THEN NULL ELSE -1 * T3."Credit" END,
            CASE WHEN T3."FCCurrency" = 'USD' THEN -1 * T3."FCCredit" ELSE NULL END,
            CASE WHEN T3."FCCurrency" = 'USD' THEN NULL ELSE -1 * T3."BalDueCred" END,
            CASE WHEN T3."FCCurrency" = 'USD' THEN -1 * T3."BalFcCred" ELSE NULL END
        FROM ORCT T2
        INNER JOIN JDT1 T3 ON T3."TransId" = T2."TransId" AND T3."ShortName" = T2."CardCode"
        WHERE T2."Canceled" = 'N' AND T2."DocType" = 'C'
) X
LEFT JOIN OCRD O ON O."CardCode" = X."CardCode"
WHERE X."Fecha" >= ? AND X."Fecha" <= ?
GROUP BY X."CardCode", O."CardName"
ORDER BY O."CardName"`,
      params: [f.dateFrom, f.dateTo],
    }),
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
  TO_VARCHAR(T0."DocDueDate",'YYYY-MM-DD') AS "Fecha Vencimiento",
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
  TO_VARCHAR(T99."DocDueDate",'YYYY-MM-DD'),
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
