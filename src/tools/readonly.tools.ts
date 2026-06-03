import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getEntity } from "../sap/entities.js";
import { searchEntity, getOne } from "./operations.js";
import { wrap } from "./helpers.js";

/**
 * Registra herramientas de SOLO LECTURA (search/get) para recursos que no
 * tienen la estructura estándar de documento con DocumentLines (pagos,
 * asientos contables). La creación/edición de estos se omite por su payload
 * especializado.
 */

interface ReadOnlyOptions {
  entity: string; // nombre de entidad en el catálogo
  prefix: string; // prefijo de herramientas, ej. "incoming_payment"
  noun: string; // sustantivo, ej. "pago de cliente"
}

export function registerReadOnlyTools(server: McpServer, opts: ReadOnlyOptions): void {
  const { entity, prefix, noun } = opts;
  const meta = getEntity(entity);
  const dateField = meta.dateField ?? "DocDate";
  const hasCard = meta.searchFields.includes("CardCode");

  server.registerTool(
    `${prefix}_search`,
    {
      title: `Buscar ${noun}s`,
      description:
        `Lista ${noun}s (solo lectura). Permite buscar por texto, ` +
        `${hasCard ? "filtrar por socio (CardCode), " : ""}rango de fechas (${dateField}) y filtro OData. ` +
        `Requiere permiso de lectura sobre ${entity}.`,
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe(`Texto a buscar en ${meta.searchFields.join("/")}`),
        ...(hasCard
          ? { cardCode: z.string().optional().describe("Filtrar por código de socio exacto") }
          : {}),
        dateFrom: z.string().optional().describe(`${dateField} desde (YYYY-MM-DD)`),
        dateTo: z.string().optional().describe(`${dateField} hasta (YYYY-MM-DD)`),
        filter: z.string().optional().describe("Filtro OData adicional"),
        top: z.number().int().min(1).max(100).optional(),
        skip: z.number().int().min(0).optional(),
        orderby: z.string().optional().describe(`Orden, ej. '${dateField} desc'`),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(`${prefix}_search`, async (args, user) => {
      const f: string[] = [];
      if (hasCard && args.cardCode) {
        f.push(`CardCode eq '${String(args.cardCode).replace(/'/g, "''")}'`);
      }
      if (args.dateFrom) f.push(`${dateField} ge '${args.dateFrom}'`);
      if (args.dateTo) f.push(`${dateField} le '${args.dateTo}'`);
      if (args.filter) f.push(`(${args.filter})`);
      return searchEntity(user, entity, {
        search: args.search,
        filter: f.length ? f.join(" and ") : undefined,
        top: args.top,
        skip: args.skip,
        orderby: args.orderby ?? `${dateField} desc`,
      });
    }),
  );

  server.registerTool(
    `${prefix}_get`,
    {
      title: `Ver ${noun}`,
      description: `Obtiene el detalle completo de un(a) ${noun} por su ${meta.keyField}.`,
      inputSchema: {
        id: z.number().int().describe(`${meta.keyField} del registro`),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(`${prefix}_get`, async (args, user) => getOne(user, entity, args.id)),
  );
}
