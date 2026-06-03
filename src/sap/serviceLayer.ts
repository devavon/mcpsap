import { Agent, fetch as uFetch, type Dispatcher } from "undici";
import { config } from "../config.js";
import { getCompany } from "./companies.js";

/** Datos de conexión a una empresa concreta. */
export interface SapTarget {
  url: string;
  companyDB: string;
  username: string;
  password: string;
  rejectUnauthorized: boolean;
}

/**
 * Cliente del SAP Business One Service Layer.
 *
 * - Usa UNA cuenta de servicio (login único).
 * - Mantiene la cookie de sesión B1SESSION y ROUTEID.
 * - Renueva automáticamente la sesión cuando expira (401).
 * - Serializa el login para evitar múltiples logins concurrentes.
 * - Usa un dispatcher de undici para keep-alive y, si se configura,
 *   aceptar el certificado autofirmado típico del Service Layer.
 *
 * NOTA de permisos: como todo pasa por la cuenta de servicio, SAP ve una
 * sola identidad. El control de permisos por usuario lo aplica la capa RBAC
 * del MCP (ver src/auth/roles.ts), ANTES de llamar a este cliente.
 */

/**
 * Extrae la causa real de un error de fetch (undici envuelve el error de red
 * en `cause`). Devuelve un mensaje accionable según el código.
 */
function describeNetError(e: any): string {
  const cause = e?.cause ?? e;
  const code = cause?.code ?? "";
  const msg = cause?.message ?? e?.message ?? String(e);
  const hints: Record<string, string> = {
    ECONNREFUSED: "conexión rechazada (¿puerto 50000 cerrado o Service Layer apagado?).",
    ETIMEDOUT: "tiempo de espera agotado (¿firewall bloquea el puerto 50000?).",
    ECONNRESET: "conexión reiniciada por el servidor.",
    ENOTFOUND: "host no encontrado (revise la URL).",
    EAI_AGAIN: "fallo de DNS temporal.",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      "certificado TLS no verificable (autofirmado): ponga SAP_TLS_REJECT_UNAUTHORIZED=false.",
    DEPTH_ZERO_SELF_SIGNED_CERT:
      "certificado autofirmado: ponga SAP_TLS_REJECT_UNAUTHORIZED=false.",
    SELF_SIGNED_CERT_IN_CHAIN:
      "cadena con certificado autofirmado: ponga SAP_TLS_REJECT_UNAUTHORIZED=false.",
    CERT_HAS_EXPIRED: "el certificado del servidor expiró.",
    ERR_TLS_CERT_ALTNAME_INVALID:
      "el certificado no coincide con la IP/host: ponga SAP_TLS_REJECT_UNAUTHORIZED=false.",
  };
  const hint = code && hints[code] ? ` — ${hints[code]}` : "";
  return `${msg}${code ? ` [${code}]` : ""}${hint}`;
}

export class SapError extends Error {
  constructor(
    message: string,
    public status: number,
    public sapCode?: string | number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "SapError";
  }
}

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Ruta relativa al base URL, ej: "BusinessPartners('C0001')". */
  path: string;
  body?: unknown;
  /** Cabeceras extra (ej. Prefer para no devolver el body en POST). */
  headers?: Record<string, string>;
  /** Reintentos internos (uso recursivo en re-login). */
  _retry?: boolean;
}

export class ServiceLayerClient {
  private cookies: string[] = [];
  private sessionTimeoutMs = 30 * 60_000; // informativo; el re-login se dispara por 401
  private loginPromise: Promise<void> | null = null;
  private dispatcher: Dispatcher;

  constructor(private target: SapTarget) {
    this.dispatcher = new Agent({
      keepAliveTimeout: 60_000,
      connect: { rejectUnauthorized: target.rejectUnauthorized },
    });
  }

  /** Login con la cuenta de servicio. Serializado para evitar carreras. */
  async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async doLogin(): Promise<void> {
    let res;
    try {
      res = await uFetch(`${this.target.url}/Login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          CompanyDB: this.target.companyDB,
          UserName: this.target.username,
          Password: this.target.password,
        }),
        dispatcher: this.dispatcher,
      });
    } catch (e: any) {
      throw new SapError(
        `No se pudo contactar el Service Layer en ${this.target.url}: ${describeNetError(e)}`,
        0,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw this.toSapError(res.status, text, "Falló el login en SAP Service Layer");
    }

    this.cookies = this.extractCookies(res.headers);
    try {
      const data = JSON.parse(text);
      if (typeof data.SessionTimeout === "number") {
        this.sessionTimeoutMs = data.SessionTimeout * 60_000;
      }
    } catch {
      /* el body de Login puede venir vacío según versión */
    }
    if (this.cookies.length === 0) {
      throw new SapError("SAP no devolvió cookie de sesión (B1SESSION).", res.status);
    }
  }

  /** Ejecuta una petición autenticada con re-login automático en 401. */
  async request<T = unknown>(opts: RequestOpts): Promise<T> {
    if (this.cookies.length === 0) await this.login();

    const url = `${this.target.url}/${opts.path.replace(/^\/+/, "")}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: this.cookies.join("; "),
      ...opts.headers,
    };

    let res;
    try {
      res = await uFetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        dispatcher: this.dispatcher,
      });
    } catch (e: any) {
      throw new SapError(`Error de red llamando a SAP: ${describeNetError(e)}`, 0);
    }

    // Sesión expirada -> re-login una vez.
    if (res.status === 401 && !opts._retry) {
      this.cookies = [];
      await this.login();
      return this.request<T>({ ...opts, _retry: true });
    }

    const text = await res.text();
    if (!res.ok) {
      throw this.toSapError(res.status, text, `Error ${res.status} en ${opts.path}`);
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** GET con query OData ya construida (sin el "?"). */
  async get<T = unknown>(path: string, query?: string): Promise<T> {
    const full = query ? `${path}?${query}` : path;
    return this.request<T>({ method: "GET", path: full });
  }

  /** POST que puede devolver o no el recurso completo. */
  async post<T = unknown>(path: string, body: unknown, returnBody = true): Promise<T> {
    return this.request<T>({
      method: "POST",
      path,
      body,
      headers: returnBody ? {} : { Prefer: "return-no-content" },
    });
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>({ method: "PATCH", path, body });
  }

  async logout(): Promise<void> {
    if (this.cookies.length === 0) return;
    try {
      await this.request({ method: "POST", path: "Logout" });
    } catch {
      /* ignore */
    }
    this.cookies = [];
  }

  private extractCookies(headers: Headers): string[] {
    const raw =
      typeof (headers as any).getSetCookie === "function"
        ? (headers as any).getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie") as string]
          : [];
    return raw
      .map((c: string) => c.split(";")[0])
      .filter((c: string) => /^(B1SESSION|ROUTEID)=/i.test(c));
  }

  private toSapError(status: number, text: string, fallbackMsg: string): SapError {
    let code: string | number | undefined;
    let msg = fallbackMsg;
    try {
      const data = JSON.parse(text);
      const err = data?.error;
      if (err) {
        code = err.code;
        msg =
          typeof err.message === "string"
            ? err.message
            : err.message?.value ?? fallbackMsg;
      }
      return new SapError(msg, status, code, data);
    } catch {
      return new SapError(text || fallbackMsg, status);
    }
  }
}

/**
 * Pool de clientes: una sesión de cuenta de servicio por empresa (alias).
 * Las credenciales de la cuenta de servicio son globales (.env); la CompanyDB
 * y, opcionalmente, la URL provienen de la definición de la empresa.
 */
const clients = new Map<string, ServiceLayerClient>();

export function getSapClient(companyAlias: string): ServiceLayerClient {
  let client = clients.get(companyAlias);
  if (!client) {
    const company = getCompany(companyAlias);
    client = new ServiceLayerClient({
      url: company.url,
      companyDB: company.companyDB,
      username: config.sap.username,
      password: config.sap.password,
      rejectUnauthorized: config.sap.rejectUnauthorized,
    });
    clients.set(companyAlias, client);
  }
  return client;
}

/** Cierra todas las sesiones SAP abiertas (al apagar el servidor). */
export async function logoutAllClients(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.logout().catch(() => {})));
}
