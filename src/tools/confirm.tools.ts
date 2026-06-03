import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSapClient } from "../sap/serviceLayer.js";
import { getCompany } from "../sap/companies.js";
import { getPending, removePending } from "../pending/store.js";
import { audit } from "../audit/logger.js";
import { text, json, errorResult, wrap } from "./helpers.js";

export function registerConfirmTools(server: McpServer): void {
  server.registerTool(
    "confirm_action",
    {
      title: "Confirmar y ejecutar una acción pendiente",
      description:
        "Ejecuta contra SAP una creación o edición previamente preparada. " +
        "Solo puede confirmar acciones que usted mismo generó y que no hayan expirado.",
      inputSchema: {
        pendingId: z.string().uuid().describe("Identificador de la acción pendiente"),
      },
      annotations: { destructiveHint: true },
    },
    wrap("confirm_action", async (args, user) => {
      const action = getPending(args.pendingId, user.username);
      if (!action) {
        return errorResult(
          "No se encontró una acción pendiente válida con ese id (o expiró, o no le pertenece).",
        );
      }

      const client = getSapClient(action.company);
      let result: unknown;
      if (action.method === "POST") {
        result = await client.post(action.path, action.payload, true);
      } else {
        await client.patch(action.path, action.payload);
        // PATCH del Service Layer devuelve 204 sin cuerpo; releemos el recurso.
        result = await client.get(action.path);
      }
      removePending(action.id);

      audit({
        username: user.username,
        role: user.role,
        company: action.company,
        action: `confirm:${action.operation}:${action.entity}`,
        entity: action.entity,
        operation: action.operation,
        outcome: "confirmed",
        target: action.id,
        payload: action.payload,
      });

      return json(
        `✅ ${action.operation === "create" ? "Creado" : "Actualizado"} en SAP ` +
          `(${action.entity} · empresa: ${getCompany(action.company).label}).`,
        result,
      );
    }),
  );

  server.registerTool(
    "cancel_action",
    {
      title: "Cancelar una acción pendiente",
      description: "Descarta una creación o edición preparada sin ejecutarla.",
      inputSchema: {
        pendingId: z.string().uuid().describe("Identificador de la acción pendiente"),
      },
    },
    wrap("cancel_action", async (args, user) => {
      const action = getPending(args.pendingId, user.username);
      if (!action) {
        return errorResult("No hay una acción pendiente válida con ese id.");
      }
      removePending(action.id);
      audit({
        username: user.username,
        role: user.role,
        company: action.company,
        action: `cancel:${action.operation}:${action.entity}`,
        entity: action.entity,
        operation: action.operation,
        outcome: "cancelled",
        target: action.id,
      });
      return text(`🗑️ Acción ${action.id} cancelada. No se envió nada a SAP.`);
    }),
  );
}
