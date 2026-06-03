import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertPermission } from "../auth/roles.js";
import { getCompany } from "../sap/companies.js";
import { odataString } from "../sap/entities.js";
import { resolveCompany } from "./operations.js";
import { audit } from "../audit/logger.js";
import { json, text, wrap } from "./helpers.js";

/**
 * Módulo de Finanzas (solo lectura). Se basa en ChartOfAccounts del Service
 * Layer. Permiso requerido: entidad lógica "Financials" con operación "read".
 *
 * Convenciones de SAP B1:
 *  - AccountType: at_Revenues (ingresos), at_Expenses (gastos), at_Other (balance).
 *  - Balance: deudor positivo / acreedor negativo. Ingresos/Pasivo/Capital
 *    quedan negativos (crédito); se presentan como positivos al resumir.
 *  - Solo cuentas imputables (ActiveAccount = 'tYES') suman en los reportes.
 */

const ENTITY = "Financials";

interface Account {
  Code: string;
  Name: string;
  AccountType: string;
  Balance: number;
  ActiveAccount: string;
}

const SELECT = "$select=Code,Name,AccountType,Balance,ActiveAccount";

/** Trae todas las cuentas imputables (ActiveAccount = 'tYES'). */
async function postableAccounts(client: ReturnType<typeof resolveCompany>["client"]): Promise<Account[]> {
  const filter = `$filter=${encodeURIComponent("ActiveAccount eq 'tYES'")}`;
  return client.getAll<Account>("ChartOfAccounts", `${SELECT}&${filter}`);
}

/** Formatea un número con separador de miles y 2 decimales. */
function fmt(n: number): string {
  return n.toLocaleString("es-CR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function registerFinanceTools(server: McpServer): void {
  // --- Saldo de una cuenta puntual ---
  server.registerTool(
    "account_balance",
    {
      title: "Saldo de una cuenta contable",
      description:
        "Devuelve el saldo de una cuenta del plan contable por su código (ej. '1-1-01-01-04-03'). Solo lectura.",
      inputSchema: {
        code: z.string().min(1).describe("Código de la cuenta (Code en ChartOfAccounts)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("account_balance", async (args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const code = String(args.code).replace(/'/g, "''");
      const acc = await client.get<Account>(`ChartOfAccounts('${code}')`, SELECT.slice(1));
      audit({ username: user.username, role: user.role, company: alias, action: "account_balance", entity: ENTITY, operation: "read", outcome: "ok", target: args.code });
      return json(`Cuenta ${acc.Code} — ${acc.Name} [${getCompany(alias).label}]`, {
        Code: acc.Code,
        Name: acc.Name,
        AccountType: acc.AccountType,
        Balance: acc.Balance,
        BalanceFormateado: fmt(acc.Balance),
      });
    }),
  );

  // --- Plan de cuentas (listado/búsqueda) ---
  server.registerTool(
    "chart_of_accounts",
    {
      title: "Plan de cuentas con saldos",
      description:
        "Lista cuentas del plan contable con su saldo. Permite buscar por código o nombre y filtrar solo las que tienen saldo. Solo lectura.",
      inputSchema: {
        search: z.string().optional().describe("Texto a buscar en código o nombre de cuenta"),
        onlyPostable: z.boolean().optional().describe("Solo cuentas imputables (def. true)"),
        onlyWithBalance: z.boolean().optional().describe("Solo cuentas con saldo distinto de cero"),
        top: z.number().int().min(1).max(500).optional().describe("Máximo de filas a devolver (def. 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("chart_of_accounts", async (args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const conds: string[] = [];
      if (args.onlyPostable !== false) conds.push("ActiveAccount eq 'tYES'");
      if (args.search) {
        const t = String(args.search);
        const vs = [...new Set([t, t.toLowerCase(), t.toUpperCase(), t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())])];
        const ors = vs.flatMap((v) => [`contains(Code,${odataString(v)})`, `contains(Name,${odataString(v)})`]);
        conds.push(`(${ors.join(" or ")})`);
      }
      const q = `${SELECT}&$orderby=Code${conds.length ? `&$filter=${encodeURIComponent(conds.join(" and "))}` : ""}`;
      let rows = await client.getAll<Account>("ChartOfAccounts", q);
      if (args.onlyWithBalance) rows = rows.filter((r) => Number(r.Balance) !== 0);
      const top = args.top ?? 50;
      const shown = rows.slice(0, top);
      audit({ username: user.username, role: user.role, company: alias, action: "chart_of_accounts", entity: ENTITY, operation: "read", outcome: "ok", detail: `${rows.length} cuentas` });
      return json(
        `Plan de cuentas [${getCompany(alias).label}] — ${shown.length} de ${rows.length} cuenta(s)${rows.length > top ? " (use 'top' o 'search' para afinar)" : ""}:`,
        shown.map((r) => ({ Code: r.Code, Name: r.Name, AccountType: r.AccountType, Balance: r.Balance })),
      );
    }),
  );

  // --- Balance de comprobación ---
  server.registerTool(
    "trial_balance",
    {
      title: "Balance de comprobación",
      description:
        "Lista las cuentas imputables con saldo (débito/crédito) y los totales. Solo lectura.",
      inputSchema: {
        minAbs: z.number().optional().describe("Umbral: omitir cuentas con |saldo| menor a este valor"),
        top: z.number().int().min(1).max(500).optional().describe("Máximo de cuentas a listar (def. 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("trial_balance", async (args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const accs = (await postableAccounts(client)).filter((a) => {
        const b = Number(a.Balance) || 0;
        return b !== 0 && Math.abs(b) >= (args.minAbs ?? 0);
      });
      let totalDebe = 0;
      let totalHaber = 0;
      for (const a of accs) {
        const b = Number(a.Balance) || 0;
        if (b >= 0) totalDebe += b;
        else totalHaber += -b;
      }
      accs.sort((a, b) => a.Code.localeCompare(b.Code));
      const top = args.top ?? 100;
      const rows = accs.slice(0, top).map((a) => {
        const b = Number(a.Balance) || 0;
        return { Code: a.Code, Name: a.Name, Debe: b >= 0 ? b : 0, Haber: b < 0 ? -b : 0 };
      });
      audit({ username: user.username, role: user.role, company: alias, action: "trial_balance", entity: ENTITY, operation: "read", outcome: "ok", detail: `${accs.length} cuentas` });
      return json(
        `Balance de comprobación [${getCompany(alias).label}] — ${rows.length} de ${accs.length} cuenta(s) con saldo\n` +
          `Total Debe: ${fmt(totalDebe)}  |  Total Haber: ${fmt(totalHaber)}  |  Diferencia: ${fmt(totalDebe - totalHaber)}`,
        rows,
      );
    }),
  );

  // --- Estado de Resultados resumido ---
  server.registerTool(
    "income_statement",
    {
      title: "Estado de Resultados (resumido)",
      description:
        "Resume Ingresos, Gastos y Utilidad/Pérdida del periodo a partir de las cuentas de resultado. Solo lectura.",
      inputSchema: {
        topAccounts: z.number().int().min(0).max(50).optional().describe("Cuántas cuentas top mostrar por grupo (def. 8)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("income_statement", async (args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const accs = await postableAccounts(client);
      const revenues = accs.filter((a) => a.AccountType === "at_Revenues");
      const expenses = accs.filter((a) => a.AccountType === "at_Expenses");
      // Ingresos son crédito (negativo): se presentan positivos.
      const ingresos = revenues.reduce((s, a) => s + -(Number(a.Balance) || 0), 0);
      const gastos = expenses.reduce((s, a) => s + (Number(a.Balance) || 0), 0);
      const utilidad = ingresos - gastos;
      const n = args.topAccounts ?? 8;
      const topRev = [...revenues].sort((a, b) => Math.abs(b.Balance) - Math.abs(a.Balance)).slice(0, n).map((a) => ({ Code: a.Code, Name: a.Name, Monto: -a.Balance }));
      const topExp = [...expenses].sort((a, b) => Math.abs(b.Balance) - Math.abs(a.Balance)).slice(0, n).map((a) => ({ Code: a.Code, Name: a.Name, Monto: a.Balance }));
      audit({ username: user.username, role: user.role, company: alias, action: "income_statement", entity: ENTITY, operation: "read", outcome: "ok" });
      return json(
        `Estado de Resultados (resumido) [${getCompany(alias).label}]\n` +
          `  Ingresos: ${fmt(ingresos)}\n` +
          `  Gastos:   ${fmt(gastos)}\n` +
          `  ${utilidad >= 0 ? "Utilidad" : "Pérdida"} del periodo: ${fmt(utilidad)}`,
        { Ingresos: ingresos, Gastos: gastos, Resultado: utilidad, TopIngresos: topRev, TopGastos: topExp },
      );
    }),
  );

  // --- Balance General resumido ---
  server.registerTool(
    "balance_sheet",
    {
      title: "Balance General (resumido)",
      description:
        "Resume Activo, Pasivo y Capital agrupando las cuentas de balance por el primer dígito del código (1=Activo, 2=Pasivo, 3=Capital). Solo lectura.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap("balance_sheet", async (_args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const accs = (await postableAccounts(client)).filter((a) => a.AccountType === "at_Other");
      const groups: Record<string, { label: string; total: number }> = {
        "1": { label: "Activo", total: 0 },
        "2": { label: "Pasivo", total: 0 },
        "3": { label: "Patrimonio/Capital", total: 0 },
        otros: { label: "Otros", total: 0 },
      };
      for (const a of accs) {
        const d = (a.Code || "").charAt(0);
        const key = groups[d] ? d : "otros";
        groups[key].total += Number(a.Balance) || 0;
      }
      // Activo es deudor (positivo); Pasivo y Capital son acreedores (negativo) -> presentar positivos.
      const activo = groups["1"].total;
      const pasivo = -groups["2"].total;
      const capital = -groups["3"].total;
      const otros = groups["otros"].total;
      const dif = activo - (pasivo + capital);
      audit({ username: user.username, role: user.role, company: alias, action: "balance_sheet", entity: ENTITY, operation: "read", outcome: "ok" });
      return json(
        `Balance General (resumido) [${getCompany(alias).label}]\n` +
          `  ACTIVO:              ${fmt(activo)}\n` +
          `  PASIVO:              ${fmt(pasivo)}\n` +
          `  PATRIMONIO/CAPITAL:  ${fmt(capital)}\n` +
          `  Pasivo + Capital:    ${fmt(pasivo + capital)}\n` +
          `  Diferencia (Activo - (Pasivo+Capital)): ${fmt(dif)}` +
          (Math.abs(dif) > 0.5 ? `\n  Nota: la diferencia suele corresponder a la utilidad/pérdida del periodo aún no cerrada (ver income_statement)${otros ? ` y a cuentas 'Otros' (${fmt(otros)})` : ""}.` : ""),
        { Activo: activo, Pasivo: pasivo, Capital: capital, Otros: otros, Diferencia: dif },
      );
    }),
  );

  // --- Auxiliar / Mayor de cuenta (asistente de conciliación bancaria) ---
  server.registerTool(
    "account_ledger",
    {
      title: "Auxiliar de cuenta (asistente de conciliación)",
      description:
        "Lista los movimientos contables de una cuenta (típicamente la bancaria) en un rango de fechas, con saldo corrido y totales. " +
        "Sirve para conciliar contra el estado de cuenta del banco: el contador compara estos movimientos con los del banco. Solo lectura.",
      inputSchema: {
        account: z.string().min(1).describe("Código de la cuenta contable (ej. cuenta bancaria '1-1-01-02-03-01')"),
        dateFrom: z.string().describe("Fecha desde (YYYY-MM-DD), por fecha del asiento (ReferenceDate)"),
        dateTo: z.string().optional().describe("Fecha hasta (YYYY-MM-DD); si se omite, hasta hoy"),
        openingBalance: z.number().optional().describe("Saldo inicial de la cuenta a 'dateFrom' (def. 0). El banco lo indica."),
        top: z.number().int().min(1).max(1000).optional().describe("Máximo de movimientos a listar (def. 200)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("account_ledger", async (args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const acc = String(args.account);

      const conds = [`ReferenceDate ge '${args.dateFrom}'`];
      if (args.dateTo) conds.push(`ReferenceDate le '${args.dateTo}'`);
      const q =
        `$filter=${encodeURIComponent(conds.join(" and "))}` +
        `&$orderby=${encodeURIComponent("ReferenceDate asc")}`;
      const entries = await client.getAll<any>("JournalEntries", q);

      const opening = args.openingBalance ?? 0;
      let saldo = opening;
      let totDebe = 0;
      let totHaber = 0;
      const movs: any[] = [];
      for (const je of entries) {
        for (const l of je.JournalEntryLines ?? []) {
          if (l.AccountCode === acc) {
            const debe = Number(l.Debit) || 0;
            const haber = Number(l.Credit) || 0;
            saldo += debe - haber;
            totDebe += debe;
            totHaber += haber;
            movs.push({
              Fecha: je.ReferenceDate,
              Asiento: je.JdtNum,
              Referencia: je.Reference,
              Memo: (l.LineMemo || je.Memo || "").slice(0, 60),
              Debe: debe,
              Haber: haber,
              SaldoCorrido: Number(saldo.toFixed(2)),
            });
          }
        }
      }

      // Nombre y saldo actual de la cuenta (referencia).
      let nombre = acc;
      let saldoActual: number | undefined;
      try {
        const a = await client.get<Account>(`ChartOfAccounts('${acc.replace(/'/g, "''")}')`, SELECT.slice(1));
        nombre = a.Name;
        saldoActual = a.Balance;
      } catch {
        /* cuenta sin detalle accesible */
      }

      const cierre = opening + (totDebe - totHaber);
      const top = args.top ?? 200;
      audit({ username: user.username, role: user.role, company: alias, action: "account_ledger", entity: ENTITY, operation: "read", outcome: "ok", target: acc, detail: `${movs.length} movs ${args.dateFrom}..${args.dateTo ?? ""}` });

      return json(
        `Auxiliar de cuenta ${acc} — ${nombre} [${getCompany(alias).label}]\n` +
          `Periodo: ${args.dateFrom}${args.dateTo ? ` a ${args.dateTo}` : " en adelante"}\n` +
          `Saldo inicial:  ${fmt(opening)}\n` +
          `Total Debe:     ${fmt(totDebe)}\n` +
          `Total Haber:    ${fmt(totHaber)}\n` +
          `Movimiento neto: ${fmt(totDebe - totHaber)}\n` +
          `Saldo final calculado: ${fmt(cierre)}` +
          (saldoActual !== undefined ? `\nSaldo actual en SAP (acumulado, referencia): ${fmt(saldoActual)}` : "") +
          `\nMovimientos: ${movs.length} (de ${entries.length} asientos del periodo)` +
          (movs.length > top ? `\nMostrando ${top}; afine el rango de fechas para ver el resto.` : ""),
        movs.slice(0, top),
      );
    }),
  );
}
