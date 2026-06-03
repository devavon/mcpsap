import bcrypt from "bcryptjs";
import { config } from "../config.js";
import type { UserContext } from "../types.js";
import { findUser } from "./store.js";
import { resolveAllowed } from "../sap/companies.js";

/**
 * Sesiones del MCP (login propio).
 *
 * Cada conexión MCP tiene un `sessionId` (provisto por el transporte
 * StreamableHTTP). Tras un login exitoso, asociamos ese sessionId al
 * UserContext. Las herramientas resuelven al usuario a partir del sessionId
 * que reciben en `extra.sessionId`.
 */

const sessions = new Map<string, UserContext>();

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Valida credenciales y registra la sesión para el sessionId dado. */
export async function login(
  sessionId: string,
  username: string,
  password: string,
): Promise<UserContext> {
  const rec = findUser(username);
  // Comparación en tiempo constante incluso si el usuario no existe.
  const hash = rec?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(password, hash);

  if (!rec || !ok) {
    throw new AuthError("Usuario o contraseña incorrectos.");
  }
  if (rec.active === false) {
    throw new AuthError("Usuario inactivo. Contacte al administrador.");
  }

  const now = Date.now();
  const allowedCompanies = resolveAllowed(rec.companies);
  const ctx: UserContext = {
    username: rec.username,
    fullName: rec.fullName ?? rec.username,
    role: rec.role,
    loginAt: now,
    lastSeen: now,
    allowedCompanies,
    // Si solo tiene acceso a una empresa, se autoselecciona.
    selectedCompany: allowedCompanies.length === 1 ? allowedCompanies[0] : undefined,
  };
  sessions.set(sessionId, ctx);
  return ctx;
}

/** Selecciona la empresa activa de la sesión (debe estar permitida). */
export function selectCompany(user: UserContext, alias: string): void {
  if (!user.allowedCompanies.includes(alias)) {
    throw new AuthError(
      `No tiene acceso a la empresa "${alias}". Empresas permitidas: ${user.allowedCompanies.join(", ") || "(ninguna)"}.`,
    );
  }
  user.selectedCompany = alias;
}

/** Devuelve el usuario de la sesión si está activa y no expiró; si no, undefined. */
export function getSessionUser(sessionId: string | undefined): UserContext | undefined {
  if (!sessionId) return undefined;
  const ctx = sessions.get(sessionId);
  if (!ctx) return undefined;
  if (Date.now() - ctx.lastSeen > config.security.sessionTtlMs) {
    sessions.delete(sessionId);
    return undefined;
  }
  ctx.lastSeen = Date.now();
  return ctx;
}

/** Igual que getSessionUser pero lanza AuthError si no hay sesión válida. */
export function requireUser(sessionId: string | undefined): UserContext {
  const ctx = getSessionUser(sessionId);
  if (!ctx) {
    throw new AuthError(
      "No ha iniciado sesión (o la sesión expiró). Use la herramienta 'login' primero.",
    );
  }
  return ctx;
}

export function logout(sessionId: string | undefined): void {
  if (sessionId) sessions.delete(sessionId);
}

/** Limpia sesiones expiradas (llamado periódicamente). */
export function sweepSessions(): void {
  const now = Date.now();
  for (const [sid, ctx] of sessions) {
    if (now - ctx.lastSeen > config.security.sessionTtlMs) sessions.delete(sid);
  }
}
