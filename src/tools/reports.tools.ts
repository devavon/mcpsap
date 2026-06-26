import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertPermission } from "../auth/roles.js";
import { getCompany } from "../sap/companies.js";
import { resolveCompany } from "./operations.js";
import { audit } from "../audit/logger.js";
import { json, wrap } from "./helpers.js";

/**
 * Reportes compuestos del lado del servidor. El más pesado (cuentas por cobrar)
 * cruza facturas, notas de crédito/débito y pagos en una sola operación, para
 * que el cliente (Claude) solo tenga que volcar el resultado a Excel.
 *
 * Permiso: entidad lógica "Financials" (read).
 */

const ENTITY = "Financials";

/** Monto en la moneda del documento (original). */
function docAmount(d: any): number {
  const fc = Number(d.DocTotalFC) || 0;
  return fc !== 0 ? fc : Number(d.DocTotal) || 0;
}

/**
 * Extrae el "apartamento" según una especificación configurable:
 *   "header:U_Campo"  -> campo de cabecera
 *   "line:U_Campo"    -> campo de la primera línea (o CostingCode/ProjectCode)
 *   undefined         -> vacío
 */
function extractField(doc: any, spec?: string): string {
  if (!spec) return "";
  const [scope, field] = spec.includes(":") ? spec.split(":") : ["header", spec];
  if (scope === "line") {
    const ln = (doc.DocumentLines || [])[0] || {};
    return ln[field] != null ? String(ln[field]) : "";
  }
  return doc[field] != null ? String(doc[field]) : "";
}

export function registerReportTools(server: McpServer): void {
  // --- CxC por saldo de cliente (exacto, vía CurrentAccountBalance) ---
  server.registerTool(
    "cuentas_por_cobrar_saldos",
    {
      title: "Cuentas por Cobrar — saldo por cliente",
      description:
        "Lista los clientes con saldo pendiente (CurrentAccountBalance) — cuánto debe cada cliente/apartamento. " +
        "Es la cifra exacta de CxC. Devuelve filas listas para Excel. Solo lectura.",
      inputSchema: {
        minAbs: z.number().optional().describe("Omitir clientes con |saldo| menor a este valor (def. 0.01)"),
        soloPositivos: z.boolean().optional().describe("Solo saldos a favor de la empresa (deudores). Def. true"),
        apartmentField: z
          .string()
          .optional()
          .describe("UDF del cliente con el apartamento, ej. 'U_Apto'. Si se omite, columna vacía."),
        top: z.number().int().min(1).max(2000).optional().describe("Máximo de filas (def. 1000)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("cuentas_por_cobrar_saldos", async (args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const apt = args.apartmentField;
      const minAbs = args.minAbs ?? 0.01;
      const soloPos = args.soloPositivos !== false;

      const sel = ["CardCode", "CardName", "CurrentAccountBalance", "Currency"];
      if (apt) sel.push(apt);
      const filter = encodeURIComponent("CardType eq 'cCustomer' and CurrentAccountBalance ne 0");
      const rows = await client.getAll<any>(
        "BusinessPartners",
        `$select=${sel.join(",")}&$filter=${filter}&$orderby=CurrentAccountBalance desc`,
      );

      let totalDeudor = 0;
      let totalAcreedor = 0;
      const data = rows
        .filter((b) => Math.abs(Number(b.CurrentAccountBalance) || 0) >= minAbs)
        .filter((b) => (soloPos ? Number(b.CurrentAccountBalance) > 0 : true))
        .map((b) => {
          const saldo = Number(b.CurrentAccountBalance) || 0;
          if (saldo > 0) totalDeudor += saldo;
          else totalAcreedor += -saldo;
          return {
            CodigoCliente: b.CardCode,
            NombreCliente: b.CardName,
            Moneda: b.Currency,
            Saldo: saldo,
            Apartamento: apt && b[apt] != null ? String(b[apt]) : "",
          };
        });

      const top = args.top ?? 1000;
      audit({
        username: user.username, role: user.role, company: alias,
        action: "cuentas_por_cobrar_saldos", entity: ENTITY, operation: "read", outcome: "ok",
        detail: `${data.length} clientes con saldo`,
      });

      return json(
        `Cuentas por Cobrar — saldo por cliente [${getCompany(alias).label}]\n` +
          `Clientes con saldo: ${data.length}\n` +
          `Total por cobrar (deudores): ${totalDeudor.toLocaleString("es-CR", { minimumFractionDigits: 2 })}` +
          (soloPos ? "" : `\nTotal a favor del cliente (anticipos): ${totalAcreedor.toLocaleString("es-CR", { minimumFractionDigits: 2 })}`) +
          (apt ? "" : "\nNota: columna 'Apartamento' vacía — indique apartmentField (UDF del cliente) para llenarla.") +
          (data.length > top ? `\nMostrando ${top} de ${data.length}.` : ""),
        data.slice(0, top),
      );
    }),
  );


  server.registerTool(
    "cuentas_por_cobrar",
    {
      title: "Reporte de Cuentas por Cobrar (facturas, NC, ND, pagos)",
      description:
        "Genera, en una sola operación, las 4 secciones del reporte de cuentas por cobrar de un rango de fechas: " +
        "Facturas, Notas de crédito, Notas de débito y Pagos recibidos (con la factura aplicada o 'pago abierto'). " +
        "Devuelve filas estructuradas listas para exportar a Excel. Solo lectura.",
      inputSchema: {
        dateFrom: z.string().describe("Fecha desde (YYYY-MM-DD), por DocDate"),
        dateTo: z.string().optional().describe("Fecha hasta (YYYY-MM-DD)"),
        apartmentField: z
          .string()
          .optional()
          .describe(
            "Dónde leer el n° de apartamento. Formato 'header:U_Campo' o 'line:U_Campo' " +
              "(ej. 'line:U_fase', 'header:U_Apto'). Si se omite, la columna va vacía.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("cuentas_por_cobrar", async (args, user) => {
      assertPermission(user, ENTITY, "read");
      const { alias, client } = resolveCompany(user);
      const apt = args.apartmentField;

      const dateFilter = (() => {
        const c = [`DocDate ge '${args.dateFrom}'`];
        if (args.dateTo) c.push(`DocDate le '${args.dateTo}'`);
        return `$filter=${encodeURIComponent(c.join(" and "))}&$orderby=${encodeURIComponent("DocDate asc")}`;
      })();

      // Traer en paralelo los 4 documentos (con líneas inline).
      const [invoices, creditNotes, debitNotes, payments] = await Promise.all([
        client.getAll<any>("Invoices", dateFilter),
        client.getAll<any>("CreditNotes", dateFilter),
        client.getAll<any>("CorrectionInvoice", dateFilter),
        client.getAll<any>("IncomingPayments", dateFilter),
      ]);

      // Mapa DocEntry -> DocNum de facturas (para resolver la factura aplicada en pagos).
      const invByEntry = new Map<number, any>();
      for (const inv of invoices) invByEntry.set(inv.DocEntry, inv);

      const facturas = invoices.map((d) => ({
        FechaFactura: d.DocDate,
        NumeroFactura: d.DocNum,
        Moneda: d.DocCurrency,
        MontoMonedaOriginal: docAmount(d),
        CodigoCliente: d.CardCode,
        NombreCliente: d.CardName,
        Apartamento: extractField(d, apt),
      }));

      const notasCredito = creditNotes.map((d) => {
        const baseEntry = (d.DocumentLines || []).find((l: any) => l.BaseEntry != null)?.BaseEntry;
        const baseInv = baseEntry != null ? invByEntry.get(baseEntry) : undefined;
        return {
          FechaEmision: d.DocDate,
          NumeroNC: d.DocNum,
          Moneda: d.DocCurrency,
          MontoMonedaOriginal: docAmount(d),
          FacturaQueAplica: baseInv?.DocNum ?? (baseEntry != null ? `entry:${baseEntry}` : ""),
          CodigoCliente: d.CardCode,
          NombreCliente: d.CardName,
          Apartamento: extractField(d, apt),
        };
      });

      const notasDebito = debitNotes.map((d) => ({
        FechaND: d.DocDate,
        NumeroND: d.DocNum,
        Moneda: d.DocCurrency,
        MontoMonedaOriginal: docAmount(d),
        CodigoCliente: d.CardCode,
        NombreCliente: d.CardName,
        Apartamento: extractField(d, apt),
      }));

      // Pagos: una fila por factura aplicada; si no hay, "pago abierto".
      const pagos: any[] = [];
      for (const p of payments) {
        const applied = p.PaymentInvoices || [];
        const monto = (Number(p.CashSum) || 0) + (Number(p.TransferSum) || 0);
        const base = {
          FechaPago: p.DocDate,
          Moneda: p.DocCurrency,
          CodigoCliente: p.CardCode,
          NombreCliente: p.CardName,
          Apartamento: extractField(p, apt),
        };
        if (applied.length === 0) {
          pagos.push({ ...base, NumeroFactura: "pago abierto", MontoMonedaOriginal: monto });
        } else {
          for (const a of applied) {
            const inv = invByEntry.get(a.DocEntry);
            pagos.push({
              ...base,
              NumeroFactura: inv?.DocNum ?? `entry:${a.DocEntry}`,
              MontoMonedaOriginal: Number(a.AppliedFC) || Number(a.AppliedSum) || 0,
            });
          }
        }
      }

      audit({
        username: user.username, role: user.role, company: alias,
        action: "cuentas_por_cobrar", entity: ENTITY, operation: "read", outcome: "ok",
        detail: `${args.dateFrom}..${args.dateTo ?? ""} F:${facturas.length} NC:${notasCredito.length} ND:${notasDebito.length} P:${pagos.length}`,
      });

      return json(
        `Cuentas por Cobrar [${getCompany(alias).label}] — periodo ${args.dateFrom}${args.dateTo ? " a " + args.dateTo : " en adelante"}\n` +
          `Facturas: ${facturas.length} | Notas de crédito: ${notasCredito.length} | Notas de débito: ${notasDebito.length} | Pagos (filas): ${pagos.length}` +
          (apt ? "" : "\nNota: columna 'Apartamento' vacía — indique apartmentField (ej. 'line:U_fase') para llenarla."),
        { Facturas: facturas, NotasCredito: notasCredito, NotasDebito: notasDebito, Pagos: pagos },
      );
    }),
  );
}
