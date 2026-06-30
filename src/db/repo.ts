import bcrypt from "bcryptjs";
import { query } from "./mysql.js";
import type {
  UsersConfig,
  RolesConfig,
  CompanyDef,
  Operation,
  UserRecord,
} from "../types.js";
import { config } from "../config.js";

/**
 * Repositorio de configuración y auditoría sobre MySQL.
 *
 * Mantiene una caché en memoria (con las MISMAS formas que usan los cargadores
 * basados en archivos) para que los getters síncronos del resto del código
 * sigan funcionando sin cambios. La caché se refresca al arrancar, cada cierto
 * tiempo y tras cada mutación del panel.
 */

let usersCache: UsersConfig = { users: [] };
let rolesCache: RolesConfig = { roles: {} };
let companiesCache: Record<string, CompanyDef> = {};

export const cachedUsers = (): UsersConfig => usersCache;
export const cachedRoles = (): RolesConfig => rolesCache;
export const cachedCompanies = (): Record<string, CompanyDef> => companiesCache;

// ----------------------------- carga / caché -----------------------------

export async function refreshConfigCache(): Promise<void> {
  // Roles + permisos
  const roles = await query<{ name: string; description: string | null }>(
    "SELECT name, description FROM mcp_roles",
  );
  const perms = await query<{ role: string; entity: string; operation: Operation }>(
    "SELECT role, entity, operation FROM mcp_role_permissions",
  );
  const rolesCfg: RolesConfig = { roles: {} };
  for (const r of roles) {
    rolesCfg.roles[r.name] = { description: r.description ?? undefined, entities: {} };
  }
  for (const p of perms) {
    const r = rolesCfg.roles[p.role];
    if (!r) continue;
    (r.entities[p.entity] ??= []).push(p.operation);
  }

  // Empresas
  const comps = await query<{ alias: string; label: string; company_db: string; url: string | null }>(
    "SELECT alias, label, company_db, url FROM mcp_companies",
  );
  const compMap: Record<string, CompanyDef> = {};
  for (const c of comps) {
    compMap[c.alias] = {
      alias: c.alias,
      label: c.label,
      companyDB: c.company_db,
      url: (c.url || config.sap.url).replace(/\/+$/, ""),
    };
  }

  // Usuarios + empresas asignadas
  const users = await query<{
    username: string;
    full_name: string | null;
    email: string | null;
    password_hash: string;
    role: string;
    active: number;
    all_companies: number;
  }>("SELECT username, full_name, email, password_hash, role, active, all_companies FROM mcp_users");
  const ucomp = await query<{ username: string; company_alias: string }>(
    "SELECT username, company_alias FROM mcp_user_companies",
  );
  const byUser: Record<string, string[]> = {};
  for (const uc of ucomp) (byUser[uc.username] ??= []).push(uc.company_alias);

  const usersCfg: UsersConfig = {
    users: users.map((u) => ({
      username: u.username,
      fullName: u.full_name ?? undefined,
      email: u.email ?? undefined,
      passwordHash: u.password_hash,
      role: u.role,
      active: !!u.active,
      companies: u.all_companies ? "*" : byUser[u.username] ?? [],
    })),
  };

  rolesCache = rolesCfg;
  companiesCache = compMap;
  usersCache = usersCfg;
}

// ------------------------------- auditoría -------------------------------

export async function insertAudit(e: {
  ts: string;
  username?: string;
  role?: string;
  company?: string;
  action?: string;
  entity?: string;
  operation?: string;
  outcome?: string;
  target?: string | number;
  detail?: string;
  params?: unknown;
}): Promise<void> {
  await query(
    `INSERT INTO mcp_audit (ts, username, role, company, action, entity, operation, outcome, target, detail, params)
     VALUES (:ts, :username, :role, :company, :action, :entity, :operation, :outcome, :target, :detail, :params)`,
    {
      ts: e.ts.replace("T", " ").replace("Z", ""),
      username: e.username ?? null,
      role: e.role ?? null,
      company: e.company ?? null,
      action: e.action ?? null,
      entity: e.entity ?? null,
      operation: e.operation ?? null,
      outcome: e.outcome ?? null,
      target: e.target != null ? String(e.target) : null,
      detail: e.detail ?? null,
      params: e.params !== undefined ? JSON.stringify(e.params).slice(0, 8000) : null,
    },
  );
}

export interface AuditFilter {
  username?: string;
  action?: string;
  company?: string;
  outcome?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function queryAudit(f: AuditFilter): Promise<any[]> {
  const where: string[] = [];
  const p: any = {};
  if (f.username) { where.push("username = :username"); p.username = f.username; }
  if (f.action) { where.push("action LIKE :action"); p.action = `%${f.action}%`; }
  if (f.company) { where.push("company = :company"); p.company = f.company; }
  if (f.outcome) { where.push("outcome = :outcome"); p.outcome = f.outcome; }
  if (f.from) { where.push("ts >= :from"); p.from = f.from; }
  if (f.to) { where.push("ts <= :to"); p.to = f.to; }
  p.limit = Math.min(f.limit ?? 100, 500);
  p.offset = f.offset ?? 0;
  const sql =
    `SELECT id, ts, username, role, company, action, entity, operation, outcome, target, detail, params
     FROM mcp_audit ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY id DESC LIMIT :limit OFFSET :offset`;
  return query(sql, p);
}

// ------------------------------- CRUD roles -------------------------------

export async function upsertRole(name: string, description: string, perms: { entity: string; operation: Operation }[]): Promise<void> {
  await query(
    "INSERT INTO mcp_roles (name, description) VALUES (:name, :description) ON DUPLICATE KEY UPDATE description = :description",
    { name, description: description || null },
  );
  await query("DELETE FROM mcp_role_permissions WHERE role = :role", { role: name });
  for (const p of perms) {
    await query(
      "INSERT IGNORE INTO mcp_role_permissions (role, entity, operation) VALUES (:role, :entity, :operation)",
      { role: name, entity: p.entity, operation: p.operation },
    );
  }
  await refreshConfigCache();
}

export async function deleteRole(name: string): Promise<void> {
  await query("DELETE FROM mcp_role_permissions WHERE role = :role", { role: name });
  await query("DELETE FROM mcp_roles WHERE name = :name", { name });
  await refreshConfigCache();
}

// ----------------------------- CRUD empresas -----------------------------

export async function upsertCompany(c: { alias: string; label: string; companyDB: string; url?: string }): Promise<void> {
  await query(
    `INSERT INTO mcp_companies (alias, label, company_db, url) VALUES (:alias, :label, :db, :url)
     ON DUPLICATE KEY UPDATE label = :label, company_db = :db, url = :url`,
    { alias: c.alias, label: c.label, db: c.companyDB, url: c.url || null },
  );
  await refreshConfigCache();
}

export async function deleteCompany(alias: string): Promise<void> {
  await query("DELETE FROM mcp_companies WHERE alias = :alias", { alias });
  await query("DELETE FROM mcp_user_companies WHERE company_alias = :alias", { alias });
  await refreshConfigCache();
}

// ----------------------------- CRUD usuarios -----------------------------

export async function upsertUser(u: {
  username: string;
  fullName?: string;
  email?: string;
  role: string;
  active: boolean;
  allCompanies: boolean;
  companies: string[];
  password?: string;
}): Promise<void> {
  let hash: string | undefined;
  if (u.password) hash = await bcrypt.hash(u.password, 10);

  const existing = await query<{ username: string }>("SELECT username FROM mcp_users WHERE username = :u", { u: u.username });
  if (existing.length) {
    await query(
      `UPDATE mcp_users SET full_name = :full, email = :email, role = :role, active = :active, all_companies = :all
       ${hash ? ", password_hash = :hash" : ""} WHERE username = :username`,
      { full: u.fullName || null, email: u.email || null, role: u.role, active: u.active ? 1 : 0, all: u.allCompanies ? 1 : 0, hash, username: u.username },
    );
  } else {
    await query(
      `INSERT INTO mcp_users (username, full_name, email, password_hash, role, active, all_companies)
       VALUES (:username, :full, :email, :hash, :role, :active, :all)`,
      { username: u.username, full: u.fullName || null, email: u.email || null, hash: hash ?? "", role: u.role, active: u.active ? 1 : 0, all: u.allCompanies ? 1 : 0 },
    );
  }

  await query("DELETE FROM mcp_user_companies WHERE username = :u", { u: u.username });
  if (!u.allCompanies) {
    for (const alias of u.companies) {
      await query(
        "INSERT IGNORE INTO mcp_user_companies (username, company_alias) VALUES (:u, :a)",
        { u: u.username, a: alias },
      );
    }
  }
  await refreshConfigCache();
}

export async function deleteUser(username: string): Promise<void> {
  await query("DELETE FROM mcp_user_companies WHERE username = :u", { u: username });
  await query("DELETE FROM mcp_users WHERE username = :u", { u: username });
  await refreshConfigCache();
}

// -------------------------------- seed ---------------------------------

/**
 * Siembra la DB si está vacía, a partir de la config actual (env JSON o
 * archivos) y garantiza el rol y el usuario superadmin.
 */
export async function seedIfEmpty(seed: {
  users: UserRecord[];
  roles: RolesConfig;
  companies: CompanyDef[];
}): Promise<void> {
  const [{ c: nRoles }] = await query<{ c: number }>("SELECT COUNT(*) AS c FROM mcp_roles");
  if (nRoles === 0) {
    for (const [name, def] of Object.entries(seed.roles.roles)) {
      const perms: { entity: string; operation: Operation }[] = [];
      for (const [entity, ops] of Object.entries(def.entities)) {
        for (const op of ops) perms.push({ entity, operation: op });
      }
      await upsertRole(name, def.description ?? "", perms);
    }
  }
  // Garantizar rol superadmin con acceso total.
  const [{ c: hasSuper }] = await query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM mcp_roles WHERE name = 'superadmin'",
  );
  if (hasSuper === 0) {
    await upsertRole("superadmin", "Administrador del conector (panel + acceso total)", [
      { entity: "*", operation: "read" },
      { entity: "*", operation: "create" },
      { entity: "*", operation: "update" },
    ]);
  }

  const [{ c: nComp }] = await query<{ c: number }>("SELECT COUNT(*) AS c FROM mcp_companies");
  if (nComp === 0) {
    for (const c of seed.companies) {
      await upsertCompany({ alias: c.alias, label: c.label, companyDB: c.companyDB, url: c.url });
    }
  }

  const [{ c: nUsers }] = await query<{ c: number }>("SELECT COUNT(*) AS c FROM mcp_users");
  if (nUsers === 0) {
    for (const u of seed.users) {
      const all = u.companies === "*" || u.companies === undefined;
      // Inserta directo conservando el hash existente (no re-hashea).
      await query(
        `INSERT INTO mcp_users (username, full_name, password_hash, role, active, all_companies)
         VALUES (:username, :full, :hash, :role, :active, :all)`,
        { username: u.username, full: u.fullName || null, hash: u.passwordHash, role: u.role, active: u.active === false ? 0 : 1, all: all ? 1 : 0 },
      );
      if (!all && Array.isArray(u.companies)) {
        for (const alias of u.companies) {
          await query("INSERT IGNORE INTO mcp_user_companies (username, company_alias) VALUES (:u, :a)", { u: u.username, a: alias });
        }
      }
    }
  }

  // Garantizar un superadmin para entrar al panel.
  const [{ c: hasSuperUser }] = await query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM mcp_users WHERE role = 'superadmin'",
  );
  if (hasSuperUser === 0) {
    const pwd = config.admin.superPassword || "superadmin123";
    if (!config.admin.superPassword) {
      console.error(
        "[admin] ⚠️ SUPERADMIN_PASSWORD no definido; se creó 'superadmin' con clave 'superadmin123'. Cámbiela en el panel.",
      );
    }
    await upsertUser({
      username: config.admin.superUser,
      fullName: "Super Administrador",
      role: "superadmin",
      active: true,
      allCompanies: true,
      companies: [],
      password: pwd,
    });
  }

  await refreshConfigCache();
}
