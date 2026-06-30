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
        <a href="/admin" class="brand">
          <img src="/assets/icon-32.png" alt="" onerror="this.style.display='none'"/>
          <span><strong>SAP B1</strong><small>Administración</small></span>
        </a>
        <div class="links">
          <a href="/admin">Inicio</a>
          <a href="/admin/users">Usuarios</a>
          <a href="/admin/roles">Roles</a>
          <a href="/admin/companies">Empresas</a>
          <a href="/admin/audit">Auditoría</a>
        </div>
        <span class="spacer"></span>
        <span class="who">${esc(admin)}</span>
        <a href="/admin/logout" class="logout">Salir</a>
       </nav>`
    : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · MCP SAP Admin</title>
<style>
  :root{
    --brand:#1b5e20;--brand-2:#2e7d32;--brand-ink:#0d3b12;
    --bg:#eef1f4;--surface:#fff;--bd:#e3e7ec;--bd-strong:#cdd4dc;
    --ink:#1f2933;--muted:#6b7785;--muted-2:#9aa5b1;
    --ok:#127a3a;--ok-bg:#e7f6ec;--err:#b42318;--err-bg:#fdecea;
    --r:10px;--r-sm:7px;
    --sh:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
    --sh-lg:0 4px 12px rgba(16,24,40,.10);
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{font-family:"Segoe UI",system-ui,Roboto,Arial,sans-serif;margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}

  /* ---- Topbar ---- */
  nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:8px;
      padding:0 18px;height:58px;background:linear-gradient(180deg,var(--brand-2),var(--brand));
      color:#fff;box-shadow:var(--sh-lg)}
  nav .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:#fff;padding-right:10px}
  nav .brand img{width:30px;height:30px;border-radius:7px;background:#fff;padding:3px;object-fit:contain}
  nav .brand strong{display:block;font-size:14px;line-height:1.1}
  nav .brand small{display:block;font-size:11px;opacity:.8}
  nav .links{display:flex;gap:4px;margin-left:8px;flex-wrap:wrap}
  nav .links a{color:#fff;text-decoration:none;font-size:13.5px;padding:7px 12px;border-radius:999px;opacity:.92;transition:background .12s,opacity .12s}
  nav .links a:hover{background:rgba(255,255,255,.14);opacity:1}
  nav .links a.active{background:#fff;color:var(--brand);font-weight:600;opacity:1}
  nav .spacer{flex:1}
  nav .who{font-size:13px;opacity:.9;display:flex;align-items:center;gap:6px}
  nav .who::before{content:"";width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.22);
      display:inline-block;background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>');background-size:18px;background-repeat:no-repeat;background-position:center}
  nav .logout{color:#fff;text-decoration:none;font-size:13px;border:1px solid rgba(255,255,255,.4);padding:6px 12px;border-radius:999px;margin-left:6px}
  nav .logout:hover{background:rgba(255,255,255,.16)}

  /* ---- Layout ---- */
  .wrap{max-width:1140px;margin:26px auto;padding:0 18px}
  h1{font-size:22px;font-weight:700;margin:0 0 4px}
  h2{font-size:15px;font-weight:600;margin:28px 0 12px;color:var(--brand-ink)}
  a{color:var(--brand-2)}

  /* ---- Cards ---- */
  .card{background:var(--surface);border:1px solid var(--bd);border-radius:var(--r);padding:20px;margin-bottom:18px;box-shadow:var(--sh)}
  .card h2:first-child{margin-top:0}

  /* ---- Tables ---- */
  table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);
        border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;box-shadow:var(--sh)}
  th,td{padding:11px 14px;border-bottom:1px solid var(--bd);text-align:left;font-size:13px;vertical-align:middle}
  thead th{background:#f5f7f9;font-weight:600;color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.4px;position:sticky;top:58px}
  tbody tr{transition:background .1s}
  tbody tr:hover{background:#f7faf8}
  tbody tr:last-child td{border-bottom:none}

  /* ---- Forms ---- */
  label{display:block;font-size:12.5px;margin:12px 0 5px;font-weight:600;color:var(--muted)}
  input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--bd-strong);border-radius:var(--r-sm);font-size:14px;font-family:inherit;color:var(--ink);background:#fff;transition:border-color .12s,box-shadow .12s}
  input:hover,select:hover,textarea:hover{border-color:var(--muted-2)}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--brand-2);box-shadow:0 0 0 3px rgba(46,125,50,.15)}
  .row{display:flex;gap:14px;flex-wrap:wrap}.row>div{flex:1;min-width:200px}

  /* ---- Buttons ---- */
  button,.btn{background:var(--brand);color:#fff;border:none;padding:9px 18px;border-radius:var(--r-sm);font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;transition:background .12s,transform .02s}
  button:hover,.btn:hover{background:var(--brand-ink)}
  button:active,.btn:active{transform:translateY(1px)}
  button.sec,.btn.sec{background:#fff;color:var(--ink);border:1px solid var(--bd-strong)}
  button.sec:hover,.btn.sec:hover{background:#f3f5f7}
  button.danger,.btn.danger{background:var(--err)}
  button.danger:hover,.btn.danger:hover{background:#8f1a12}

  /* ---- Misc ---- */
  .pill{display:inline-block;background:var(--ok-bg);color:var(--ok);padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;margin:1px}
  .muted{color:var(--muted);font-size:12px}
  .err{background:var(--err-bg);color:var(--err);padding:12px 14px;border-radius:var(--r-sm);margin:12px 0;border:1px solid #f4c7c2}
  .ok{background:var(--ok-bg);color:var(--ok);padding:12px 14px;border-radius:var(--r-sm);margin:12px 0;border:1px solid #b8e6c6}
  .actions{display:flex;gap:6px;flex-wrap:wrap}
  code{background:#eef1f4;padding:2px 6px;border-radius:5px;font-size:12px;color:var(--brand-ink)}

  /* ---- Login (sin nav) ---- */
  body.login{display:grid;place-items:center}
  body.login .wrap{max-width:380px;width:100%;margin:0}
  body.login .card{box-shadow:var(--sh-lg);padding:26px}
</style></head><body class="${admin ? "" : "login"}">${nav}<div class="wrap">${body}</div>
<script>
  (function(){var p=location.pathname.replace(/\\/$/,"")||"/admin";
   document.querySelectorAll('nav .links a').forEach(function(a){
     if(a.getAttribute('href')===p)a.classList.add('active');});})();
</script>
</body></html>`;
}
