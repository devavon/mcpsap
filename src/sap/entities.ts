/**
 * Catálogo de entidades de SAP B1 expuestas por el MCP en v1.
 * El nombre lógico coincide con el recurso del Service Layer.
 */

export type EntityKind = "master" | "salesDoc" | "purchaseDoc";

export interface EntityMeta {
  /** Recurso del Service Layer, ej. "BusinessPartners". */
  resource: string;
  /** Nombre amigable en español. */
  label: string;
  kind: EntityKind;
  /** Campo clave primaria del recurso. */
  keyField: string;
  /** Si la clave es string (se encierra entre comillas en la URL OData). */
  keyIsString: boolean;
  /** Campos sugeridos para listados ($select). */
  defaultSelect: string[];
  /** Campos de texto donde buscar con "contains". */
  searchFields: string[];
}

export const ENTITIES: Record<string, EntityMeta> = {
  BusinessPartners: {
    resource: "BusinessPartners",
    label: "Socios de negocio (clientes/proveedores)",
    kind: "master",
    keyField: "CardCode",
    keyIsString: true,
    defaultSelect: ["CardCode", "CardName", "CardType", "Phone1", "EmailAddress", "Currency"],
    searchFields: ["CardCode", "CardName"],
  },
  Quotations: {
    resource: "Quotations",
    label: "Cotizaciones de venta",
    kind: "salesDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
  },
  Orders: {
    resource: "Orders",
    label: "Órdenes de venta",
    kind: "salesDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
  },
  Invoices: {
    resource: "Invoices",
    label: "Facturas de venta",
    kind: "salesDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
  },
  PurchaseOrders: {
    resource: "PurchaseOrders",
    label: "Órdenes de compra",
    kind: "purchaseDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
  },
  PurchaseInvoices: {
    resource: "PurchaseInvoices",
    label: "Facturas de compra (proveedores)",
    kind: "purchaseDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
  },
};

export function getEntity(name: string): EntityMeta {
  const e = ENTITIES[name];
  if (!e) throw new Error(`Entidad desconocida: ${name}`);
  return e;
}

/** Construye la ruta a un recurso por clave, citando si es string. */
export function keyPath(entity: EntityMeta, key: string | number): string {
  const k = entity.keyIsString ? `'${String(key).replace(/'/g, "''")}'` : key;
  return `${entity.resource}(${k})`;
}

/** Escapa una cadena para usarla en un literal OData (contains/eq). */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
