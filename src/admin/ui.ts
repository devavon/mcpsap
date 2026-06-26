import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

/** Sesiones del panel admin (en memoria, cookie httpOnly). */
interface AdminSession {
  username: string;
  ts: number;
}
const sessions = new Map<string, AdminSession>();
const TTL = 8 * 60 * 60_000; // 8 horas
const COOKIE = "mcp_admin";

export function createSession(username: string, res: Response): void {
  const token = randomUUID();
  sessions.set(token, { username, ts: Date.now() });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", maxAge: TTL });
}

export function destroySession(req: Request, res: Response): void {
  const t = readCookie(req, COOKIE);
  if (t) sessions.delete(t);
  res.clearCookie(COOKIE);
}

export function currentAdmin(req: Request): string | null {
  const t = readCookie(req, COOKIE);
  if (!t) return null;
  const s = sessions.get(t);
  if (!s) return null;
  if (Date.now() - s.ts > TTL) {
    sessions.delete(t);
    return null;
  }
  return s.username;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v ?? "");
  }
  return null;
}

/** Escapa texto para HTML. */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renderiza una página completa con navegación. */
export function page(title: string, body: string, admin?: string | null): string {
  const nav = admin
    ? `<nav>
        <a href="/admin">Inicio</a>
        <a href="/admin/users">Usuarios</a>
        <a href="/admin/roles">Roles</a>
        <a href="/admin/companies">Empresas</a>
        <a href="/admin/audit">Auditoría</a>
        <span class="spacer"></span>
        <span class="who">👤 ${esc(admin)}</span>
        <a href="/admin/logout">Salir</a>
       </nav>`
    : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · MCP SAP Admin</title>
<style>
  :root{--b:#1b5e20;--bg:#f5f6f8;--bd:#dde1e7}
  *{box-sizing:border-box}
  body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:var(--bg);color:#222}
  nav{background:var(--b);color:#fff;display:flex;gap:14px;align-items:center;padding:10px 18px}
  nav a{color:#fff;text-decoration:none;font-size:14px;opacity:.92}
  nav a:hover{opacity:1;text-decoration:underline}
  nav .spacer{flex:1}
  nav .who{font-size:13px;opacity:.85}
  .wrap{max-width:1100px;margin:22px auto;padding:0 18px}
  h1{font-size:20px} h2{font-size:16px;margin-top:26px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--bd);border-radius:8px;overflow:hidden}
  th,td{padding:8px 10px;border-bottom:1px solid var(--bd);text-align:left;font-size:13px;vertical-align:top}
  th{background:#eef1f4;font-weight:600}
  tr:last-child td{border-bottom:none}
  .card{background:#fff;border:1px solid var(--bd);border-radius:8px;padding:18px;margin-bottom:18px}
  label{display:block;font-size:13px;margin:10px 0 4px;font-weight:600}
  input,select,textarea{width:100%;padding:8px;border:1px solid var(--bd);border-radius:6px;font-size:14px;font-family:inherit}
  .row{display:flex;gap:14px;flex-wrap:wrap}.row>div{flex:1;min-width:200px}
  button,.btn{background:var(--b);color:#fff;border:none;padding:9px 16px;border-radius:6px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
  button.sec,.btn.sec{background:#607d8b}
  button.danger,.btn.danger{background:#c62828}
  .pill{display:inline-block;background:#e8f5e9;color:#1b5e20;padding:2px 8px;border-radius:10px;font-size:12px;margin:1px}
  .muted{color:#777;font-size:12px}
  .err{background:#fdecea;color:#b71c1c;padding:10px;border-radius:6px;margin:10px 0}
  .ok{background:#e8f5e9;color:#1b5e20;padding:10px;border-radius:6px;margin:10px 0}
  .actions{display:flex;gap:6px}
  code{background:#eef1f4;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body>${nav}<div class="wrap">${body}</div></body></html>`;
}
