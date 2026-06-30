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

/** Hostname del servidor del Service Layer (para reutilizarlo como host de HANA). */
function slHostname(): string {
  try {
    return new URL(optional("SAP_SL_URL", "")).hostname;
  } catch {
    return "";
  }
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
  db: {
    // Si se define, usuarios/roles/empresas/auditoría se gestionan en MySQL
    // (fuente de verdad) y se habilita el panel /admin.
    url: optional("DATABASE_URL", ""),
  },
  hana: {
    // Conexión directa a SAP HANA para informes SQL (antigüedad CxC,
    // obligaciones con pagos, etc.). El HOST por defecto se toma del mismo
    // servidor del Service Layer (SAP_SL_URL); basta definir HANA_USER y
    // HANA_PASSWORD (el usuario de HANA es distinto al de B1). Puerto 30015.
    host: optional("HANA_HOST", "") || slHostname(),
    port: intOpt("HANA_PORT", 30015),
    user: optional("HANA_USER", ""),
    password: optional("HANA_PASSWORD", ""),
    encrypt: optional("HANA_ENCRYPT", "true").toLowerCase() !== "false",
    sslValidate: optional("HANA_SSL_VALIDATE", "false").toLowerCase() === "true",
  },
  admin: {
    // Usuario superadmin inicial para entrar al panel (se siembra si no existe).
    superUser: optional("SUPERADMIN_USERNAME", "superadmin"),
    superPassword: optional("SUPERADMIN_PASSWORD", ""),
  },
  audit: {
    dir: optional("AUDIT_DIR", "./audit-logs"),
    // En plataformas con disco efímero (Railway), conviene loguear también a
    // stdout para que el agregador de logs lo capture.
    stdout: optional("AUDIT_STDOUT", "false").toLowerCase() === "true",
  },
};

export type AppConfig = typeof config;
