import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import {
  login,
  logout,
  selectCompany,
  getSessionUser,
  AuthError,
} from "../auth/session.js";
import { getCompany } from "../sap/companies.js";
import { ENTITIES, type EntityMeta } from "../sap/entities.js";
import { REPORTS, getReport, type FilterDef } from "../sap/reports.js";
import { runHanaQuery, hanaEnabled } from "../sap/hana.js";
import { roleAllows, assertPermission } from "../auth/roles.js";
import { PermissionError } from "../auth/roles.js";
import { SapError } from "../sap/serviceLayer.js";
import { queryEntityRows, resolveCompany } from "../tools/operations.js";
import { audit } from "../audit/logger.js";
import type { UserContext } from "../types.js";

/** Filtros que ofrece una entidad estándar, según sus metadatos. */
function entityFilters(meta: EntityMeta): FilterDef[] {
  const f: FilterDef[] = [];
  if (meta.searchFields.length)
    f.push({ key: "search", label: "Buscar", type: "text", placeholder: `busca en ${meta.searchFields.join(", ")}` });
  if (meta.searchFields.includes("CardCode"))
    f.push({ key: "cardCode", label: "Socio (CardCode)", type: "text", placeholder: "código exacto" });
  if (meta.dateField) {
    f.push({ key: "dateFrom", label: "Desde", type: "date" });
    f.push({ key: "dateTo", label: "Hasta", type: "date" });
  }
  return f;
}

/**
 * API REST de SOLO LECTURA para el add-in de Excel (Office.js).
 *
 * Reutiliza el mismo motor que el MCP:
 *  - login bcrypt + sesiones con TTL (auth/session) — el token REST ES un sessionId.
 *  - RBAC por rol (auth/roles).
 *  - cliente del Service Layer + auditoría (tools/operations -> queryEntityRows).
 *
 * No expone NINGUNA escritura. El control de permisos y la auditoría son los
 * mismos que aplica el conector MCP.
 */

/** Extrae el Bearer token de la cabecera Authorization. */
function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return undefined;
}

/** Perfil que se devuelve al cliente tras login / select-company. */
function profile(token: string, user: UserContext) {
  return {
    token,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    companies: user.allowedCompanies.map((alias) => ({
      alias,
      label: getCompany(alias).label,
    })),
    selectedCompany: user.selectedCompany ?? null,
  };
}

/** Middleware: resuelve el usuario a partir del Bearer token o devuelve 401. */
function requireAuth(
  req: Request & { user?: UserContext; token?: string },
  res: Response,
  next: NextFunction,
): void {
  const token = bearer(req);
  const user = getSessionUser(token);
  if (!token || !user) {
    res.status(401).json({ error: "No autenticado o sesión expirada. Inicie sesión de nuevo." });
    return;
  }
  req.user = user;
  req.token = token;
  next();
}

/** Traduce errores conocidos a respuestas HTTP legibles. */
function fail(res: Response, e: unknown): void {
  if (e instanceof AuthError) return void res.status(401).json({ error: e.message });
  if (e instanceof PermissionError) return void res.status(403).json({ error: e.message });
  if (e instanceof SapError)
    return void res.status(502).json({ error: `SAP (${e.status}): ${e.message}`, sapCode: e.sapCode });
  res.status(500).json({ error: (e as Error)?.message ?? String(e) });
}

export function createRestRouter(): Router {
  const router = Router();

  // --- Login: valida credenciales y emite un token (sessionId) ---
  router.post("/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body ?? {};
      if (!username || !password) {
        return void res.status(400).json({ error: "Faltan usuario o contraseña." });
      }
      const token = randomUUID();
      const user = await login(token, String(username), String(password));
      res.json(profile(token, user));
    } catch (e) {
      fail(res, e);
    }
  });

  // --- Perfil de la sesión actual ---
  router.get("/me", requireAuth, (req: Request & { user?: UserContext; token?: string }, res) => {
    res.json(profile(req.token!, req.user!));
  });

  // --- Empresas a las que el usuario tiene acceso ---
  router.get("/companies", requireAuth, (req: Request & { user?: UserContext }, res) => {
    const u = req.user!;
    res.json({
      selectedCompany: u.selectedCompany ?? null,
      companies: u.allowedCompanies.map((alias) => ({ alias, label: getCompany(alias).label })),
    });
  });

  // --- Seleccionar empresa activa ---
  router.post(
    "/select-company",
    requireAuth,
    (req: Request & { user?: UserContext; token?: string }, res) => {
      try {
        const { alias } = req.body ?? {};
        if (!alias) return void res.status(400).json({ error: "Falta el alias de empresa." });
        selectCompany(req.user!, String(alias));
        res.json(profile(req.token!, req.user!));
      } catch (e) {
        fail(res, e);
      }
    },
  );

  // --- Catálogo: entidades legibles + informes financieros (si tiene acceso) ---
  router.get("/entities", requireAuth, (req: Request & { user?: UserContext }, res) => {
    const role = req.user!.role;
    const entities = Object.keys(ENTITIES)
      .filter((name) => roleAllows(role, ENTITIES[name].permEntity ?? name, "read"))
      .map((name) => {
      const e = ENTITIES[name];
      return {
        name,
        label: e.label,
        kind: e.kind,
        type: "entity" as const,
        keyField: e.keyField,
        searchFields: e.searchFields,
        dateField: e.dateField ?? null,
        filters: entityFilters(e),
        supportsAll: true,
      };
    });

    // Informes financieros: requieren lectura sobre la entidad lógica "Financials".
    // Los informes SQL solo se listan si HANA está configurado.
    const reports = roleAllows(role, "Financials", "read")
      ? Object.values(REPORTS)
          .filter((r) => r.run || (r.sql && hanaEnabled()))
          .map((r) => ({
            name: r.name,
            label: r.label,
            kind: r.kind,
            type: "report" as const,
            description: r.description,
            filters: r.filters,
            supportsAll: false,
          }))
      : [];

    res.json({ entities: [...reports, ...entities] });
  });

  // --- Consulta de datos / informes (solo lectura) -> filas para Excel ---
  router.post("/query", requireAuth, async (req: Request & { user?: UserContext }, res) => {
    try {
      const b = req.body ?? {};
      const name = b.entity ? String(b.entity) : "";
      if (!name) return void res.status(400).json({ error: "Falta 'entity'." });
      const flt: Record<string, string> = b.filters && typeof b.filters === "object" ? b.filters : {};

      // ---- Informe financiero ----
      const report = getReport(name);
      if (report) {
        assertPermission(req.user!, "Financials", "read");
        for (const fd of report.filters) {
          if (fd.required && !flt[fd.key]) {
            return void res.status(400).json({ error: `El informe requiere "${fd.label}".` });
          }
        }
        const { alias, client } = resolveCompany(req.user!);

        let rows: Record<string, unknown>[];
        let columns: string[] | null = null;
        if (report.sql) {
          // Informe SQL directo a HANA, sobre el esquema (CompanyDB) de la empresa.
          const companyDB = getCompany(alias).companyDB;
          const { text, params } = report.sql(flt);
          rows = await runHanaQuery(companyDB, text, params);
          columns = rows.length ? Object.keys(rows[0]) : null;
        } else {
          const out = await report.run!(client, flt);
          rows = out.rows;
          columns = out.columns ?? null;
        }

        audit({
          username: req.user!.username,
          role: req.user!.role,
          company: alias,
          action: `report:${name}`,
          entity: "Financials",
          operation: "read",
          outcome: "ok",
          detail: `${JSON.stringify(flt)} -> ${rows.length} filas`,
        });
        return void res.json({
          entity: name,
          label: report.label,
          company: alias,
          companyLabel: getCompany(alias).label,
          rows,
          columns,
        });
      }

      // ---- Entidad estándar ----
      const meta = ENTITIES[name];
      const f: string[] = [];
      if (flt.cardCode) f.push(`CardCode eq '${String(flt.cardCode).replace(/'/g, "''")}'`);
      const dateField = meta?.dateField ?? "DocDate";
      if (flt.dateFrom) f.push(`${dateField} ge '${flt.dateFrom}'`);
      if (flt.dateTo) f.push(`${dateField} le '${flt.dateTo}'`);
      if (b.filter) f.push(`(${b.filter})`);

      const result = await queryEntityRows(req.user!, name, {
        search: flt.search ? String(flt.search) : undefined,
        filter: f.length ? f.join(" and ") : undefined,
        orderby: b.orderby ? String(b.orderby) : undefined,
        all: b.all === true,
        allColumns: b.allColumns !== false, // por defecto todas las columnas
        top: typeof b.top === "number" ? b.top : undefined,
      });
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  // --- Cerrar sesión ---
  router.post("/logout", requireAuth, (req: Request & { token?: string }, res) => {
    logout(req.token);
    res.json({ ok: true });
  });

  return router;
}
