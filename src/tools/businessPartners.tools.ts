import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchEntity, getOne, prepareCreate, prepareUpdate } from "./operations.js";
import { wrap } from "./helpers.js";

const ENTITY = "BusinessPartners";

export function registerBusinessPartnerTools(server: McpServer): void {
  server.registerTool(
    "bp_search",
    {
      title: "Buscar socios de negocio",
      description:
        "Busca clientes/proveedores por código o nombre. Permite filtrar por tipo (C=cliente, S=proveedor) " +
        "y usar un filtro OData adicional. Requiere permiso de lectura sobre BusinessPartners.",
      inputSchema: {
        search: z.string().optional().describe("Texto a buscar en CardCode o CardName"),
        cardType: z
          .enum(["cCustomer", "cSupplier", "cLid"])
          .optional()
          .describe("Tipo de socio: cCustomer, cSupplier o cLid (lead)"),
        filter: z.string().optional().describe("Filtro OData adicional, ej: \"Currency eq 'CRC'\""),
        top: z.number().int().min(1).max(100).optional().describe("Máximo de resultados (def. 20)"),
        skip: z.number().int().min(0).optional().describe("Saltar N (paginación)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("bp_search", async (args, user) => {
      const extra = args.cardType ? `CardType eq '${args.cardType}'` : undefined;
      const filter = [args.filter, extra].filter(Boolean).join(" and ") || undefined;
      return searchEntity(user, ENTITY, {
        search: args.search,
        filter,
        top: args.top,
        skip: args.skip,
      });
    }),
  );

  server.registerTool(
    "bp_get",
    {
      title: "Ver un socio de negocio",
      description: "Obtiene el detalle completo de un socio por su CardCode.",
      inputSchema: {
        cardCode: z.string().min(1).describe("Código del socio (CardCode)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("bp_get", async (args, user) => getOne(user, ENTITY, args.cardCode)),
  );

  server.registerTool(
    "bp_create",
    {
      title: "Crear socio de negocio (requiere confirmación)",
      description:
        "Prepara la creación de un cliente o proveedor. NO se crea hasta confirmar con confirm_action. " +
        "Campos típicos: CardCode, CardName, CardType (cCustomer/cSupplier), Currency, Phone1, EmailAddress.",
      inputSchema: {
        cardCode: z.string().min(1).describe("Código único del socio"),
        cardName: z.string().min(1).describe("Nombre/razón social"),
        cardType: z.enum(["cCustomer", "cSupplier", "cLid"]).describe("Tipo de socio"),
        currency: z.string().optional().describe("Moneda, ej. CRC o USD"),
        phone1: z.string().optional(),
        emailAddress: z.string().optional(),
        federalTaxID: z.string().optional().describe("Cédula/identificación fiscal"),
        extraFields: z
          .record(z.any())
          .optional()
          .describe("Campos adicionales del Service Layer (clave/valor)"),
      },
    },
    wrap("bp_create", async (args, user) => {
      const payload: Record<string, unknown> = {
        CardCode: args.cardCode,
        CardName: args.cardName,
        CardType: args.cardType,
        ...(args.currency ? { Currency: args.currency } : {}),
        ...(args.phone1 ? { Phone1: args.phone1 } : {}),
        ...(args.emailAddress ? { EmailAddress: args.emailAddress } : {}),
        ...(args.federalTaxID ? { FederalTaxID: args.federalTaxID } : {}),
        ...(args.extraFields ?? {}),
      };
      return prepareCreate(user, ENTITY, payload);
    }),
  );

  server.registerTool(
    "bp_update",
    {
      title: "Editar socio de negocio (requiere confirmación)",
      description:
        "Prepara la edición de un socio existente (PATCH parcial). NO se aplica hasta confirmar con confirm_action.",
      inputSchema: {
        cardCode: z.string().min(1).describe("Código del socio a editar"),
        fields: z
          .record(z.any())
          .describe("Campos a modificar, ej. { \"Phone1\": \"2222-3333\", \"EmailAddress\": \"x@y.com\" }"),
      },
    },
    wrap("bp_update", async (args, user) =>
      prepareUpdate(user, ENTITY, args.cardCode, args.fields),
    ),
  );
}
