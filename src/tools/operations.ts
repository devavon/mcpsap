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
function resolveCompany(user: UserContext): { alias: string; client: ReturnType<typeof getSapClient> } {
  if (!user.selectedCompany) {
    throw new AuthError(
      `Debe seleccionar una empresa antes de operar. Empresas disponibles: ` +
        `${user.allowedCompanies.join(", ") || "(ninguna)"}. Use 'list_companies' y luego 'select_company'.`,
    );
  }
  return { alias: user.selectedCompany, client: getSapClient(user.selectedCompany) };
}

/** Construye el querystring OData a partir de parámetros de búsqueda. */
function buildQuery(
  entity: EntityMeta,
  params: {
    search?: string;
    filter?: string;
    top?: number;
    skip?: number;
    orderby?: string;
    select?: string[];
  },
): string {
  const parts: string[] = [];
  const filters: string[] = [];

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

  const select = params.select?.length ? params.select : entity.defaultSelect;
  parts.push(`$select=${encodeURIComponent(select.join(","))}`);
  parts.push(`$top=${Math.min(Math.max(params.top ?? 20, 1), 100)}`);
  if (params.skip) parts.push(`$skip=${params.skip}`);
  if (params.orderby) parts.push(`$orderby=${encodeURIComponent(params.orderby)}`);

  return parts.join("&");
}

/** Búsqueda/listado (requiere permiso read). */
export async function searchEntity(
  user: UserContext,
  entityName: string,
  params: {
    search?: string;
    filter?: string;
    top?: number;
    skip?: number;
    orderby?: string;
    select?: string[];
  },
): Promise<CallToolResult> {
  const entity = getEntity(entityName);
  assertPermission(user, entityName, "read");
  const { alias, client } = resolveCompany(user);

  const query = buildQuery(entity, params);
  const res = await client.get<{ value: unknown[] }>(entity.resource, query);
  const rows = res?.value ?? [];

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

  return json(`${entity.label} — ${rows.length} resultado(s) [empresa: ${getCompany(alias).label}]:`, rows);
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
