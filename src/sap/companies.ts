import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import type { CompaniesConfig, CompanyDef } from "../types.js";

/**
 * Catálogo de empresas (CompanyDB) de SAP B1.
 *
 * Se define en config/companies.json. Si el archivo no existe pero hay un
 * SAP_COMPANY_DB en .env, se sintetiza una única empresa "default"
 * (modo monoempresa / retrocompatibilidad).
 */

let cache: { mtime: number; data: Record<string, CompanyDef> } | null = null;
let envCache: Record<string, CompanyDef> | null = null;

/** Convierte el objeto crudo de companies.json al mapa interno. */
function buildFromRaw(raw: CompaniesConfig): Record<string, CompanyDef> {
  const data: Record<string, CompanyDef> = {};
  for (const [alias, def] of Object.entries(raw.companies ?? {})) {
    if (!def.companyDB) {
      throw new Error(`La empresa "${alias}" no tiene companyDB.`);
    }
    data[alias] = {
      alias,
      label: def.label ?? alias,
      companyDB: def.companyDB,
      url: (def.url ?? config.sap.url).replace(/\/+$/, ""),
    };
  }
  return data;
}

function buildDefault(): Record<string, CompanyDef> {
  if (!config.sap.companyDB) {
    throw new Error(
      "No hay empresas configuradas: cree config/companies.json o defina SAP_COMPANY_DB en .env.",
    );
  }
  return {
    default: {
      alias: "default",
      label: config.sap.companyDB,
      companyDB: config.sap.companyDB,
      url: config.sap.url,
    },
  };
}

function load(): Record<string, CompanyDef> {
  // 1) Variable de entorno COMPANIES_JSON (despliegues en la nube).
  if (process.env.COMPANIES_JSON) {
    if (!envCache) {
      envCache = buildFromRaw(JSON.parse(process.env.COMPANIES_JSON) as CompaniesConfig);
    }
    return envCache;
  }

  // 2) Archivo config/companies.json.
  const abs = resolve(config.files.companiesFile);
  if (!existsSync(abs)) {
    cache = null;
    return buildDefault();
  }
  const { mtimeMs } = statSync(abs);
  if (cache && cache.mtime === mtimeMs) return cache.data;

  const raw = JSON.parse(readFileSync(abs, "utf8")) as CompaniesConfig;
  const data = buildFromRaw(raw);
  if (Object.keys(data).length === 0) return buildDefault();
  cache = { mtime: mtimeMs, data };
  return data;
}

export function getAllCompanies(): CompanyDef[] {
  return Object.values(load());
}

export function getCompany(alias: string): CompanyDef {
  const c = load()[alias];
  if (!c) throw new Error(`Empresa desconocida: "${alias}".`);
  return c;
}

export function companyExists(alias: string): boolean {
  return !!load()[alias];
}

/** Resuelve la lista de aliases permitidos a un usuario. */
export function resolveAllowed(spec: string[] | "*" | undefined): string[] {
  const all = Object.keys(load());
  if (spec === undefined || spec === "*") return all;
  return spec.filter((a) => all.includes(a));
}
