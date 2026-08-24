/**
 * Cliente de la API REST del conector MCPSAP (solo lectura).
 * El token de sesión y la URL del backend se guardan en localStorage.
 */

export interface Company {
  alias: string;
  label: string;
}

export interface Profile {
  token: string;
  username: string;
  fullName: string;
  role: string;
  companies: Company[];
  selectedCompany: string | null;
}

export interface FilterDef {
  key: string;
  label: string;
  type: "text" | "date" | "select";
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

export interface EntityMeta {
  name: string;
  label: string;
  kind: string;
  type: "entity" | "report";
  description?: string;
  keyField?: string;
  searchFields?: string[];
  dateField?: string | null;
  filters: FilterDef[];
  supportsAll: boolean;
}

export interface QueryParams {
  entity: string;
  filters?: Record<string, string>;
  filter?: string;
  orderby?: string;
  top?: number;
  all?: boolean;
  allColumns?: boolean;
}

export interface QueryResult {
  entity: string;
  label: string;
  company: string;
  companyLabel: string;
  rows: Record<string, unknown>[];
  columns?: string[] | null;
}

const LS_URL = "sapaddin.apiUrl";
const LS_TOKEN = "sapaddin.token";

export class ApiError extends Error {}

export class SapApi {
  private baseUrl: string;
  private token: string | null;

  constructor() {
    // Por defecto apunta al MISMO dominio que sirve el add-in (.../api), de modo
    // que en producción (servido por MCPSAP) funciona sin configurar nada. En
    // desarrollo (taskpane en localhost) usa el backend local en el puerto 4000.
    const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const fallback = isLocal ? "https://localhost:4000/api" : `${location.origin}/api`;
    this.baseUrl = localStorage.getItem(LS_URL) || fallback;
    this.token = localStorage.getItem(LS_TOKEN);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
    localStorage.setItem(LS_URL, this.baseUrl);
  }

  hasToken(): boolean {
    return !!this.token;
  }

  private async req<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(
        `No se pudo contactar el servidor (${this.baseUrl}). ¿Está encendido y es HTTPS? ${(e as Error).message}`,
      );
    }

    const text = await res.text();
    const data = text ? safeJson(text) : {};
    if (!res.ok) {
      throw new ApiError((data as any)?.error || `Error ${res.status}`);
    }
    return data as T;
  }

  async login(username: string, password: string): Promise<Profile> {
    const p = await this.req<Profile>("/login", "POST", { username, password });
    this.token = p.token;
    localStorage.setItem(LS_TOKEN, p.token);
    return p;
  }

  async me(): Promise<Profile> {
    return this.req<Profile>("/me", "GET");
  }

  async selectCompany(alias: string): Promise<Profile> {
    return this.req<Profile>("/select-company", "POST", { alias });
  }

  async entities(): Promise<EntityMeta[]> {
    const r = await this.req<{ entities: EntityMeta[] }>("/entities", "GET");
    return r.entities;
  }

  async query(params: QueryParams): Promise<QueryResult> {
    return this.req<QueryResult>("/query", "POST", params);
  }

  async logout(): Promise<void> {
    try {
      await this.req("/logout", "POST");
    } catch {
      /* ignore */
    }
    this.token = null;
    localStorage.removeItem(LS_TOKEN);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
