import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthTools } from "./auth.tools.js";
import { registerCompanyTools } from "./company.tools.js";
import { registerConfirmTools } from "./confirm.tools.js";
import { registerBusinessPartnerTools } from "./businessPartners.tools.js";
import { registerDocumentTools } from "./documents.tools.js";
import { registerReadOnlyTools } from "./readonly.tools.js";
import { registerFinanceTools } from "./finance.tools.js";

/** Registra TODAS las herramientas del MCP en el servidor dado. */
export function registerAllTools(server: McpServer): void {
  // Autenticación, selección de empresa y confirmación de escrituras.
  registerAuthTools(server);
  registerCompanyTools(server);
  registerConfirmTools(server);

  // Maestros.
  registerBusinessPartnerTools(server);

  // Documentos de venta.
  registerDocumentTools(server, { entity: "Quotations", prefix: "sales_quotation", noun: "cotización" });
  registerDocumentTools(server, { entity: "Orders", prefix: "sales_order", noun: "orden de venta" });
  registerDocumentTools(server, { entity: "Invoices", prefix: "sales_invoice", noun: "factura de venta" });

  // Documentos de compra.
  registerDocumentTools(server, { entity: "PurchaseOrders", prefix: "purchase_order", noun: "orden de compra" });
  registerDocumentTools(server, { entity: "PurchaseInvoices", prefix: "purchase_invoice", noun: "factura de compra" });

  // Notas de crédito y de débito (cliente y proveedor).
  registerDocumentTools(server, { entity: "CreditNotes", prefix: "credit_note", noun: "nota de crédito de cliente" });
  registerDocumentTools(server, { entity: "PurchaseCreditNotes", prefix: "purchase_credit_note", noun: "nota de crédito de proveedor" });
  registerDocumentTools(server, { entity: "CorrectionInvoice", prefix: "debit_note", noun: "nota de débito de cliente" });
  registerDocumentTools(server, { entity: "CorrectionPurchaseInvoice", prefix: "purchase_debit_note", noun: "nota de débito de proveedor" });

  // Pagos (solo lectura) y asientos contables (solo lectura).
  registerReadOnlyTools(server, { entity: "IncomingPayments", prefix: "incoming_payment", noun: "pago/cobro de cliente" });
  registerReadOnlyTools(server, { entity: "VendorPayments", prefix: "vendor_payment", noun: "pago a proveedor" });
  registerReadOnlyTools(server, { entity: "JournalEntries", prefix: "journal_entry", noun: "asiento contable" });

  // Finanzas (solo lectura).
  registerFinanceTools(server);
}
