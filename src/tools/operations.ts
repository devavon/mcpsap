import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UserContext } from "../types.js";
import { getSapClient } from "../sap/serviceLayer.js";
import { getCompany } from "../sap/companies.js";
import { getEntity, keyPath, odataString, type EntityMeta } from "../sap/entities.js";
import { assertPermission } from "../auth/roles.js";
import { AuthError } from "../auth/session.js";
import { audit } from "../audit/logger.js";
import { createPending } from "../pending/store.js";
import { json, text } from "./helpers.js";

/**
 * Resuelve la empresa activa del usuario y su cliente SAP. Si el usuario tiene
 * varias empresas y no ha seleccionado ninguna, exige que lo haga primero.
 */
export function resolveCompany(user: UserContext): { alias: string; client: ReturnType<typeof getSapClient> } {
  if (!user.selectedCompany) {
    throw new AuthError(
      `Debe seleccionar una empresa antes de operar. Empresas disponibles: ` +
        `${user.allowedCompanies.join(", ") || "(ninguna)"}. Use 'list_companies' y luego 'select_company'.`,
    );
  }
  return { alias: user.selectedCompany, client: getSapClient(user.selectedCompany) };
}

/** Construye el querystring OData a partir de parámetros de búsqueda. */
function buildQuery(entity: EntityMeta, params: QueryParams): string {
  const parts: string[] = [];
  const filters: string[] = [];

  if (entity.baseFilter) filters.push(`(${entity.baseFilter})`);
  if (params.filter) filters.push(`(${params.filter})`);

  if (params.search && entity.searchFields.length) {
    // El Service Layer de SAP B1 (HANA) NO soporta tolower/toupper en $filter
    // y 'contains' es sensible a mayúsculas. Para simular insensibilidad,
    // generamos variantes de capitalización del término y las combinamos con OR.
    const t = params.search.trim();
    const titleCase = t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const variants = [...new Set([t, t.toLowerCase(), t.toUpperCase(), titleCase])];
    const ors: string[] = [];
    for (const f of entity.searchFields) {
      for (const v of variants) ors.push(`contains(${f},${odataString(v)})`);
    }
    filters.push(`(${ors.join(" or ")})`);
  }

  if (filters.length) parts.push(`$filter=${encodeURIComponent(filters.join(" and "))}`);

  // Columnas: por defecto el $select de la entidad; con allColumns se omite el
  // $select para que SAP devuelva TODOS los campos del registro.
  if (!params.allColumns) {
    const select = [...(params.select?.length ? params.select : entity.defaultSelect)];
    // Asegura los campos de importe en ambas monedas para documentos.
    const amt = docAmounts(entity);
    if (amt) for (const f of [amt.currency, amt.local, amt.system]) if (!select.includes(f)) select.push(f);
    parts.push(`$select=${encodeURIComponent([...new Set(select)].join(","))}`);
  }
  if (params.expand) parts.push(`$expand=${encodeURIComponent(params.expand)}`);

  // Con all=true paginamos fuera de aquí (getAll), sin $top/$skip.
  if (!params.all) {
    parts.push(`$top=${Math.min(Math.max(params.top ?? 20, 1), 1000)}`);
    if (params.skip) parts.push(`$skip=${params.skip}`);
  }
  if (params.orderby) parts.push(`$orderby=${encodeURIComponent(params.orderby)}`);

  return parts.join("&");
}

export interface QueryParams {
  search?: string;
  filter?: string;
  top?: number;
  skip?: number;
  orderby?: string;
  select?: string[];
  /** Trae TODAS las filas paginando (ignora top/skip). */
  all?: boolean;
  /** Omite $select para devolver todas las columnas. */
  allColumns?: boolean;
  /** $expand OData (p.ej. "JournalEntryLines"). */
  expand?: string;
}

export interface QueryResult {
  entity: string;
  label: string;
  company: string;
  companyLabel: string;
  rows: Record<string, unknown>[];
  /** Orden sugerido de columnas (cuando se añaden columnas derivadas). */
  columns?: string[];
}

/**
 * Campos de importe por tipo de documento. En SAP B1 el total se guarda en
 * moneda local (DocTotal = colones), de sistema (DocTotalSys = dólares) y de la
 * propia moneda del documento (DocTotalFC). Devolvemos los tres separados.
 */
function docAmounts(entity: EntityMeta): { currency: string; local: string; system: string } | null {
  if (entity.kind === "salesDoc" || entity.kind === "purchaseDoc") {
    return { currency: "DocCurrency", local: "DocTotal", system: "DocTotalSys" };
  }
  return null;
}

/** "COL" -> "CRC" para mostrar; el resto tal cual (USD, EUR…). */
function showCurrency(v: unknown): string {
  const c = String(v ?? "").toUpperCase();
  return c === "COL" ? "CRC" : c;
}

/** Ordena columnas: las preferidas presentes primero, luego el resto. */
function orderColumns(rows: Record<string, unknown>[], preferred: string[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  const add = (k: string) => {
    if (!seen.has(k) && !k.startsWith("odata.") && !k.includes("@")) {
      seen.add(k);
      cols.push(k);
    }
  };
  for (const k of preferred) if (rows[0] && k in rows[0]) add(k);
  for (const r of rows) for (const k of Object.keys(r)) add(k);
  return cols;
}

/**
 * Núcleo de lectura: valida permiso, resuelve empresa, consulta el Service
 * Layer y devuelve las filas crudas + metadatos. Lo usan tanto las
 * herramientas MCP (searchEntity) como la API REST del add-in de Excel.
 */
export async function queryEntityRows(
  user: UserContext,
  entityName: string,
  params: QueryParams,
): Promise<QueryResult> {
  const entity = getEntity(entityName);
  assertPermission(user, entity.permEntity ?? entityName, "read");
  const { alias, client } = resolveCompany(user);

  const query = buildQuery(entity, params);
  const rows = params.all
    ? await client.getAll<Record<string, unknown>>(entity.resource, query)
    : (await client.get<{ value: Record<string, unknown>[] }>(entity.resource, query))?.value ?? [];

  // Separación de monedas: para documentos, añade columnas claras Moneda / ₡ / $.
  let columns: string[] | undefined;
  const amt = docAmounts(entity);
  if (amt && rows.length) {
    for (const r of rows) {
      r["Moneda doc."] = showCurrency(r[amt.currency]);
      r["Total ₡ (CRC)"] = r[amt.local] ?? null;
      r["Total $ (USD)"] = r[amt.system] ?? null;
    }
    columns = orderColumns(rows, [
      entity.keyField, "DocNum", "DocDate", "CardCode", "CardName",
      "Moneda doc.", "Total ₡ (CRC)", "Total $ (USD)", "DocumentStatus",
    ]);
  }

  audit({
    username: user.username,
    role: user.role,
    company: alias,
    action: `search:${entityName}`,
    entity: entityName,
    operation: "read",
    outcome: "ok",
    detail: `search=${params.search ?? ""} filter=${params.filter ?? ""} -> ${rows.length} filas`,
  });

  return {
    entity: entityName,
    label: entity.label,
    company: alias,
    companyLabel: getCompany(alias).label,
    rows,
    columns,
  };
}

/** Búsqueda/listado (requiere permiso read). */
export async function searchEntity(
  user: UserContext,
  entityName: string,
  params: QueryParams,
): Promise<CallToolResult> {
  const r = await queryEntityRows(user, entityName, params);
  return json(`${r.label} — ${r.rows.length} resultado(s) [empresa: ${r.companyLabel}]:`, r.rows);
}

/** Lectura de un registro por su clave (requiere permiso read). */
export async function getOne(
  user: UserContext,
  entityName: string,
  key: string | number,
  select?: string[],
): Promise<CallToolResult> {
  const entity = getEntity(entityName);
  assertPermission(user, entityName, "read");
  const { alias, client } = resolveCompany(user);

  const q = select?.length ? `$select=${encodeURIComponent(select.join(","))}` : undefined;
  const data = await client.get(keyPath(entity, key), q);

  audit({
    username: user.username,
    role: user.role,
    company: alias,
    action: `get:${entityName}`,
    entity: entityName,
    operation: "read",
    outcome: "ok",
    target: key,
  });

  return json(`${entity.label} — ${entity.keyField}=${key}:`, data);
}

/**
 * Prepara una CREACIÓN: valida permiso, genera acción pendiente con resumen
 * y devuelve instrucciones para confirmar. NO ejecuta contra SAP todavía.
 */
export async function prepareCreate(
  user: UserContext,
  entityName: string,
  payload: Record<string, unknown>,
): Promise<CallToolResult> {
  const entity = getEntity(entityName);
  assertPermission(user, entityName, "create");
  const { alias } = resolveCompany(user);

  const summary = summarize(entity, "create", undefined, payload, getCompany(alias).label);
  const pending = createPending({
    username: user.username,
    company: alias,
    summary,
    entity: entityName,
    operation: "create",
    method: "POST",
    path: entity.resource,
    payload,
  });

  audit({
    username: user.username,
    role: user.role,
    company: alias,
    action: `prepare-create:${entityName}`,
    entity: entityName,
    operation: "create",
    outcome: "pending",
    target: pending.id,
    payload,
  });

  return text(
    `🟡 CONFIRMACIÓN REQUERIDA — Crear ${entity.label}\n\n${summary}\n\n` +
      `Para ejecutar, confirme con la herramienta \`confirm_action\` usando:\n` +
      `  pendingId = ${pending.id}\n\n` +
      `Para descartar, use \`cancel_action\` con ese mismo id. ` +
      `La solicitud expira en unos minutos si no se confirma.`,
  );
}

/**
 * Prepara una ACTUALIZACIÓN (PATCH parcial). Valida permiso update y genera
 * acción pendiente. NO ejecuta hasta confirmación.
 */
export async function prepareUpdate(
  user: UserContext,
  entityName: string,
  key: string | number,
  payload: Record<string, unknown>,
): Promise<CallToolResult> {
  const entity = getEntity(entityName);
  assertPermission(user, entityName, "update");
  const { alias } = resolveCompany(user);

  const summary = summarize(entity, "update", key, payload, getCompany(alias).label);
  const pending = createPending({
    username: user.username,
    company: alias,
    summary,
    entity: entityName,
    operation: "update",
    method: "PATCH",
    path: keyPath(entity, key),
    payload,
  });

  audit({
    username: user.username,
    role: user.role,
    company: alias,
    action: `prepare-update:${entityName}`,
    entity: entityName,
    operation: "update",
    outcome: "pending",
    target: pending.id,
    payload,
  });

  return text(
    `🟡 CONFIRMACIÓN REQUERIDA — Editar ${entity.label} (${entity.keyField}=${key})\n\n${summary}\n\n` +
      `Para ejecutar, confirme con \`confirm_action\` usando:\n  pendingId = ${pending.id}\n\n` +
      `Para descartar, use \`cancel_action\` con ese id.`,
  );
}

/** Genera un resumen legible del cambio que el usuario va a confirmar. */
function summarize(
  entity: EntityMeta,
  op: "create" | "update",
  key: string | number | undefined,
  payload: Record<string, unknown>,
  companyLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`Empresa: ${companyLabel}`);
  lines.push(`Operación: ${op === "create" ? "CREAR" : "EDITAR"} ${entity.resource}`);
  if (key !== undefined) lines.push(`Registro: ${entity.keyField} = ${key}`);

  // Resumen de cabecera amigable para documentos.
  const head: string[] = [];
  for (const f of ["CardCode", "CardName", "DocDate", "DocDueDate", "Comments"]) {
    if (payload[f] !== undefined) head.push(`  ${f}: ${JSON.stringify(payload[f])}`);
  }
  if (head.length) lines.push("Cabecera:", ...head);

  // Líneas del documento.
  const docLines = (payload["DocumentLines"] ?? payload["BPAddresses"]) as unknown;
  if (Array.isArray(docLines)) {
    lines.push(`Líneas: ${docLines.length}`);
    docLines.slice(0, 10).forEach((l: any, i: number) => {
      const item = l.ItemCode ?? l.ItemDescription ?? "";
      const qty = l.Quantity ?? "";
      const price = l.UnitPrice ?? l.Price ?? "";
      lines.push(`  ${i + 1}. ${item} x${qty} @ ${price}`);
    });
    if (docLines.length > 10) lines.push(`  … y ${docLines.length - 10} más`);
  }

  lines.push("", "Payload completo:", "```json", JSON.stringify(payload, null, 2), "```");
  return lines.join("\n");
}
