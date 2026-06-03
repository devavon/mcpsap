import "dotenv/config";

/**
 * Carga y valida la configuración desde variables de entorno (.env).
 * Falla rápido si falta algo crítico para conectar con SAP.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function intOpt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  sap: {
    url: required("SAP_SL_URL").replace(/\/+$/, ""),
    // CompanyDB por defecto (modo monoempresa / retrocompatibilidad).
    // En multiempresa se definen en config/companies.json.
    companyDB: optional("SAP_COMPANY_DB", ""),
    username: required("SAP_USERNAME"),
    password: required("SAP_PASSWORD"),
    rejectUnauthorized:
      optional("SAP_TLS_REJECT_UNAUTHORIZED", "true").toLowerCase() !== "false",
  },
  server: {
    host: optional("MCP_HOST", "0.0.0.0"),
    // En Railway/Heroku el puerto lo inyecta la plataforma vía PORT.
    port: intOpt("PORT", intOpt("MCP_PORT", 3000)),
    path: optional("MCP_PATH", "/mcp"),
  },
  security: {
    sessionTtlMs: intOpt("MCP_SESSION_TTL_MIN", 60) * 60_000,
    pendingTtlMs: intOpt("MCP_PENDING_TTL_MIN", 10) * 60_000,
    // Si se define, exige la cabecera 'x-api-key' (o Authorization: Bearer) en
    // cada petición al endpoint MCP. Recomendado al exponer públicamente.
    apiKey: optional("MCP_API_KEY", ""),
  },
  files: {
    rolesFile: optional("ROLES_FILE", "./config/roles.json"),
    usersFile: optional("USERS_FILE", "./config/users.json"),
    companiesFile: optional("COMPANIES_FILE", "./config/companies.json"),
  },
  audit: {
    dir: optional("AUDIT_DIR", "./audit-logs"),
    // En plataformas con disco efímero (Railway), conviene loguear también a
    // stdout para que el agregador de logs lo capture.
    stdout: optional("AUDIT_STDOUT", "false").toLowerCase() === "true",
  },
};

export type AppConfig = typeof config;
