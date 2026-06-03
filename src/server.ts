import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";

/** Crea una instancia de McpServer con todas las herramientas registradas. */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "mcp-sap-b1",
      version: "1.0.0",
    },
    {
      instructions:
        "Conector de SAP Business One (Service Layer/HANA) con control de permisos por rol. " +
        "FLUJO OBLIGATORIO: 1) el usuario debe ejecutar 'login' antes que nada. " +
        "2) Las búsquedas/lecturas (bp_search, *_search, *_get) se ejecutan directamente si el rol lo permite. " +
        "3) Toda creación/edición (*_create, *_update, bp_create, bp_update) NO se ejecuta de inmediato: " +
        "devuelve un resumen y un pendingId que el usuario debe confirmar con 'confirm_action' " +
        "(o descartar con 'cancel_action'). Muestre siempre el resumen al usuario y pida su confirmación explícita " +
        "antes de llamar a confirm_action.",
    },
  );

  registerAllTools(server);
  return server;
}
