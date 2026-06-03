import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthTools } from "./auth.tools.js";
import { registerCompanyTools } from "./company.tools.js";
import { registerConfirmTools } from "./confirm.tools.js";
import { registerBusinessPartnerTools } from "./businessPartners.tools.js";
import { registerDocumentTools } from "./documents.tools.js";

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
}
