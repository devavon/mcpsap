/**
 * Catálogo de entidades de SAP B1 expuestas por el MCP en v1.
 * El nombre lógico coincide con el recurso del Service Layer.
 */

export type EntityKind = "master" | "salesDoc" | "purchaseDoc" | "payment" | "journal";

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
  /** Campo de fecha para filtros por rango (def. DocDate). */
  dateField?: string;
  /**
   * Filtro OData fijo que se aplica SIEMPRE (se combina con AND a los del
   * usuario). Útil cuando varios "tipos de documento" comparten recurso y se
   * distinguen por una columna (p.ej. notas de débito en OINV vía DocumentSubType).
   */
  baseFilter?: string;
  /**
   * Entidad lógica contra la que se valida el permiso RBAC. Si se omite, se usa
   * el propio nombre de la entidad. Permite que vistas derivadas (notas de
   * débito) reutilicen el permiso de su recurso base (Invoices/PurchaseInvoices).
   */
  permEntity?: string;
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
    // OINV contiene también las notas de débito; aquí mostramos solo facturas.
    baseFilter: "DocumentSubType ne 'bod_DebitMemo'",
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
    baseFilter: "DocumentSubType ne 'bod_PurchaseDebitMemo'",
  },
  CreditNotes: {
    resource: "CreditNotes",
    label: "Notas de crédito de cliente",
    kind: "salesDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
  },
  PurchaseCreditNotes: {
    resource: "PurchaseCreditNotes",
    label: "Notas de crédito de proveedor",
    kind: "purchaseDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
  },
  ARDebitMemos: {
    resource: "Invoices",
    label: "Notas de débito de cliente",
    kind: "salesDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
    dateField: "DocDate",
    // Las notas de débito de cliente viven en OINV (Invoices) marcadas con este subtipo.
    baseFilter: "DocumentSubType eq 'bod_DebitMemo'",
    permEntity: "Invoices",
  },
  APDebitMemos: {
    resource: "PurchaseInvoices",
    label: "Notas de débito de proveedor",
    kind: "purchaseDoc",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocumentStatus"],
    searchFields: ["CardCode", "CardName"],
    dateField: "DocDate",
    // Las notas de débito de proveedor viven en OPCH (PurchaseInvoices).
    baseFilter: "DocumentSubType eq 'bod_PurchaseDebitMemo'",
    permEntity: "PurchaseInvoices",
  },
  IncomingPayments: {
    resource: "IncomingPayments",
    label: "Pagos / cobros de clientes",
    kind: "payment",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocCurrency", "CashSum", "TransferSum", "DeductionSum"],
    searchFields: ["CardCode", "CardName"],
    dateField: "DocDate",
  },
  VendorPayments: {
    resource: "VendorPayments",
    label: "Pagos a proveedores",
    kind: "payment",
    keyField: "DocEntry",
    keyIsString: false,
    defaultSelect: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocCurrency", "CashSum", "TransferSum", "DeductionSum"],
    searchFields: ["CardCode", "CardName"],
    dateField: "DocDate",
  },
  JournalEntries: {
    resource: "JournalEntries",
    label: "Asientos contables (libro diario)",
    kind: "journal",
    keyField: "JdtNum",
    keyIsString: false,
    defaultSelect: ["JdtNum", "Number", "ReferenceDate", "TaxDate", "Memo", "Reference"],
    searchFields: ["Memo", "Reference"],
    dateField: "ReferenceDate",
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
