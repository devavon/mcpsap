import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import type {
  UsersConfig,
  RolesConfig,
  CompaniesConfig,
  CompanyDef,
  UserRecord,
} from "../types.js";

/**
 * Lee la configuración actual (variables de entorno JSON o archivos) para
 * sembrar la base de datos la primera vez. Es independiente de los cargadores
 * normales (que ya consultan la DB cuando está habilitada).
 */

function readEnvOrFile<T>(envVar: string, file: string): T | null {
  const env = process.env[envVar];
  if (env) {
    try {
      return JSON.parse(env) as T;
    } catch {
      /* ignore */
    }
  }
  const abs = resolve(file);
  if (existsSync(abs)) {
    try {
      return JSON.parse(readFileSync(abs, "utf8")) as T;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function seedUsers(): UserRecord[] {
  const c = readEnvOrFile<UsersConfig>("USERS_JSON", config.files.usersFile);
  return c?.users ?? [];
}

export function seedRoles(): RolesConfig {
  return readEnvOrFile<RolesConfig>("ROLES_JSON", config.files.rolesFile) ?? { roles: {} };
}

export function seedCompanies(): CompanyDef[] {
  const c = readEnvOrFile<CompaniesConfig>("COMPANIES_JSON", config.files.companiesFile);
  if (!c?.companies) return [];
  return Object.entries(c.companies).map(([alias, d]) => ({
    alias,
    label: d.label ?? alias,
    companyDB: d.companyDB,
    url: (d.url ?? config.sap.url).replace(/\/+$/, ""),
  }));
}
