import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchEntity, getOne, prepareCreate, prepareUpdate } from "./operations.js";
import { wrap } from "./helpers.js";

/**
 * Registra el set estándar de herramientas (search/get/create/update) para un
 * documento de SAP B1 (ventas o compras). Todos comparten estructura de
 * cabecera + líneas, así que se generan con una fábrica común.
 */

const lineSchema = z
  .object({
    ItemCode: z.string().optional().describe("Código de artículo"),
    ItemDescription: z.string().optional(),
    Quantity: z.number().optional(),
    UnitPrice: z.number().optional().describe("Precio unitario"),
    DiscountPercent: z.number().optional(),
    TaxCode: z.string().optional().describe("Código de impuesto, ej. IVA13"),
    WarehouseCode: z.string().optional(),
  })
  .catchall(z.any())
  .describe("Línea del documento; admite campos adicionales del Service Layer");

interface DocToolOptions {
  entity: string; // nombre de entidad (= recurso del Service Layer)
  prefix: string; // prefijo de las herramientas, ej. "sales_order"
  noun: string; // sustantivo en español, ej. "orden de venta"
}

export function registerDocumentTools(server: McpServer, opts: DocToolOptions): void {
  const { entity, prefix, noun } = opts;

  server.registerTool(
    `${prefix}_search`,
    {
      title: `Buscar ${noun}s`,
      description:
        `Lista ${noun}s. Permite buscar por socio (CardCode/CardName), filtro OData adicional y paginación. ` +
        `Requiere permiso de lectura sobre ${entity}.`,
      inputSchema: {
        search: z.string().optional().describe("Texto a buscar en CardCode/CardName"),
        cardCode: z.string().optional().describe("Filtrar por código de socio exacto"),
        dateFrom: z.string().optional().describe("DocDate desde (YYYY-MM-DD)"),
        dateTo: z.string().optional().describe("DocDate hasta (YYYY-MM-DD)"),
        filter: z.string().optional().describe("Filtro OData adicional"),
        top: z.number().int().min(1).max(100).optional(),
        skip: z.number().int().min(0).optional(),
        orderby: z.string().optional().describe("Orden, ej. 'DocDate desc'"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(`${prefix}_search`, async (args, user) => {
      const f: string[] = [];
      if (args.cardCode) f.push(`CardCode eq '${String(args.cardCode).replace(/'/g, "''")}'`);
      if (args.dateFrom) f.push(`DocDate ge '${args.dateFrom}'`);
      if (args.dateTo) f.push(`DocDate le '${args.dateTo}'`);
      if (args.filter) f.push(`(${args.filter})`);
      return searchEntity(user, entity, {
        search: args.search,
        filter: f.length ? f.join(" and ") : undefined,
        top: args.top,
        skip: args.skip,
        orderby: args.orderby ?? "DocDate desc",
      });
    }),
  );

  server.registerTool(
    `${prefix}_get`,
    {
      title: `Ver ${noun}`,
      description: `Obtiene el detalle completo de un(a) ${noun} por su DocEntry (clave interna).`,
      inputSchema: {
        docEntry: z.number().int().describe("DocEntry del documento"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(`${prefix}_get`, async (args, user) => getOne(user, entity, args.docEntry)),
  );

  server.registerTool(
    `${prefix}_create`,
    {
      title: `Crear ${noun} (requiere confirmación)`,
      description:
        `Prepara la creación de un(a) ${noun}. NO se crea hasta confirmar con confirm_action. ` +
        `Requiere CardCode y al menos una línea con ItemCode y Quantity.`,
      inputSchema: {
        cardCode: z.string().min(1).describe("Código del socio de negocio"),
        docDate: z.string().optional().describe("Fecha del documento (YYYY-MM-DD)"),
        docDueDate: z.string().optional().describe("Fecha de vencimiento/entrega (YYYY-MM-DD)"),
        comments: z.string().optional().describe("Comentarios"),
        documentLines: z.array(lineSchema).min(1).describe("Líneas del documento"),
        extraFields: z
          .record(z.any())
          .optional()
          .describe("Campos extra de cabecera del Service Layer"),
      },
    },
    wrap(`${prefix}_create`, async (args, user) => {
      const payload: Record<string, unknown> = {
        CardCode: args.cardCode,
        ...(args.docDate ? { DocDate: args.docDate } : {}),
        ...(args.docDueDate ? { DocDueDate: args.docDueDate } : {}),
        ...(args.comments ? { Comments: args.comments } : {}),
        DocumentLines: args.documentLines,
        ...(args.extraFields ?? {}),
      };
      return prepareCreate(user, entity, payload);
    }),
  );

  server.registerTool(
    `${prefix}_update`,
    {
      title: `Editar ${noun} (requiere confirmación)`,
      description:
        `Prepara la edición de un(a) ${noun} existente (PATCH parcial por DocEntry). ` +
        `NO se aplica hasta confirmar con confirm_action. Para reemplazar líneas, incluya DocumentLines completas.`,
      inputSchema: {
        docEntry: z.number().int().describe("DocEntry del documento a editar"),
        fields: z.record(z.any()).describe("Campos a modificar (cabecera y/o DocumentLines)"),
      },
    },
    wrap(`${prefix}_update`, async (args, user) =>
      prepareUpdate(user, entity, args.docEntry, args.fields),
    ),
  );
}
