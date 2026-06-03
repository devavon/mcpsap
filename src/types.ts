/** Operaciones controladas por permisos. */
export type Operation = "read" | "create" | "update";

/** Definición de un rol: qué operaciones permite por entidad. */
export interface RoleDef {
  description?: string;
  /** Mapa entidad -> operaciones permitidas. La clave "*" aplica a todas. */
  entities: Record<string, Operation[]>;
}

export interface RolesConfig {
  roles: Record<string, RoleDef>;
}

/** Definición de una empresa (CompanyDB) de SAP B1. */
export interface CompanyDef {
  /** Alias corto e interno, ej. "empresa1". */
  alias: string;
  /** Nombre amigable, ej. "Comercial Uno S.A." */
  label: string;
  /** Base de datos de la compañía en SAP, ej. "SBO_EMP1". */
  companyDB: string;
  /** URL del Service Layer; si se omite usa SAP_SL_URL global. */
  url: string;
}

export interface CompaniesConfig {
  companies: Record<string, Omit<CompanyDef, "alias" | "url"> & { url?: string }>;
}

/** Usuario del MCP (login propio). */
export interface UserRecord {
  username: string;
  fullName?: string;
  role: string;
  passwordHash: string;
  active?: boolean;
  /**
   * Empresas a las que el usuario tiene acceso (aliases de companies.json).
   * Use "*" o omita para conceder TODAS las empresas configuradas.
   */
  companies?: string[] | "*";
}

export interface UsersConfig {
  users: UserRecord[];
}

/** Contexto del usuario autenticado en una sesión MCP. */
export interface UserContext {
  username: string;
  fullName: string;
  role: string;
  loginAt: number;
  lastSeen: number;
  /** Aliases de empresas a las que el usuario tiene acceso. */
  allowedCompanies: string[];
  /** Empresa actualmente seleccionada para operar (alias). */
  selectedCompany?: string;
}

/** Acción de escritura pendiente de confirmación. */
export interface PendingAction {
  id: string;
  username: string;
  /** Empresa (alias) contra la que se ejecutará la acción. */
  company: string;
  /** Descripción legible que se muestra al usuario antes de confirmar. */
  summary: string;
  entity: string;
  operation: Operation;
  /** Método HTTP y ruta relativa del Service Layer a ejecutar. */
  method: "POST" | "PATCH";
  path: string;
  payload: unknown;
  createdAt: number;
  expiresAt: number;
}
