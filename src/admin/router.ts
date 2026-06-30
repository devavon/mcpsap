import express, { type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { findUser, getRoles } from "../auth/store.js";
import { getAllCompanies } from "../sap/companies.js";
import { ENTITIES } from "../sap/entities.js";
import type { Operation } from "../types.js";
import {
  upsertUser, deleteUser, upsertRole, deleteRole, upsertCompany, deleteCompany,
  queryAudit, cachedUsers,
} from "../db/repo.js";
import { audit } from "../audit/logger.js";
import { config } from "../config.js";
import { sendMail, mailEnabled, generatePassword, credentialsEmail } from "../mail/sendgrid.js";
import { page, esc, searchBar, createSession, destroySession, currentAdmin } from "./ui.js";

/** Entidades disponibles para asignar permisos en roles. */
const ALL_ENTITIES = [...Object.keys(ENTITIES), "Financials"];
const OPS: Operation[] = ["read", "create", "update"];

export function createAdminRouter(): express.Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: true }));

  // ----------------------------- login -----------------------------
  r.get("/login", (req, res) => {
    if (currentAdmin(req)) return res.redirect("/admin");
    const err = req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : "";
    res.send(page("Ingreso", `
      <div class="card" style="max-width:380px;margin:60px auto">
        <h1>Panel MCP SAP</h1>
        <p class="muted">Acceso de administración (rol superadmin)</p>
        ${err}
        <form method="post" action="/admin/login">
          <label>Usuario</label><input name="username" autofocus>
          <label>Contraseña</label><input name="password" type="password">
          <div style="margin-top:16px"><button>Ingresar</button></div>
        </form>
      </div>`));
  });

  r.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const rec = findUser(String(username || ""));
    const ok = rec && (await bcrypt.compare(String(password || ""), rec.passwordHash));
    if (!rec || !ok || rec.active === false || rec.role !== "superadmin") {
      audit({ username: String(username || "?"), role: "-", action: "admin:login", outcome: "denied" });
      return res.redirect("/admin/login?err=" + encodeURIComponent("Credenciales inválidas o sin permiso de superadmin."));
    }
    createSession(rec.username, res);
    audit({ username: rec.username, role: rec.role, action: "admin:login", outcome: "ok" });
    res.redirect("/admin");
  });

  r.get("/logout", (req, res) => {
    destroySession(req, res);
    res.redirect("/admin/login");
  });

  // -------------------------- guard de sesión --------------------------
  const guard = (req: Request, res: Response, next: NextFunction) => {
    const a = currentAdmin(req);
    if (!a) return res.redirect("/admin/login");
    (req as any).admin = a;
    next();
  };

  // ----------------------------- dashboard -----------------------------
  r.get("/", guard, (req, res) => {
    const admin = (req as any).admin as string;
    const users = cachedUsers().users.length;
    const roles = Object.keys(getRoles().roles).length;
    const comps = getAllCompanies().length;
    res.send(page("Inicio", `
      <h1>Administración del conector MCP SAP</h1>
      <div class="row">
        <div class="card"><h2>${users}</h2><div class="muted">Usuarios</div><a class="btn" href="/admin/users">Gestionar</a></div>
        <div class="card"><h2>${roles}</h2><div class="muted">Roles</div><a class="btn" href="/admin/roles">Gestionar</a></div>
        <div class="card"><h2>${comps}</h2><div class="muted">Empresas</div><a class="btn" href="/admin/companies">Gestionar</a></div>
        <div class="card"><h2>📋</h2><div class="muted">Auditoría</div><a class="btn" href="/admin/audit">Ver registros</a></div>
      </div>`, admin));
  });

  // ------------------------------ usuarios ------------------------------
  r.get("/users", guard, (req, res) => {
    const admin = (req as any).admin as string;
    const rows = cachedUsers().users.map((u) => `
      <tr>
        <td><b>${esc(u.username)}</b><br><span class="muted">${esc(u.fullName ?? "")}</span></td>
        <td>${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
        <td>${esc(u.role)}</td>
        <td>${u.companies === "*" ? '<span class="pill">TODAS</span>' : (u.companies as string[]).map((c) => `<span class="pill">${esc(c)}</span>`).join(" ") || '<span class="muted">ninguna</span>'}</td>
        <td>${u.active === false ? '<span class="muted">inactivo</span>' : "✅"}</td>
        <td class="actions">
          <a class="btn sec" href="/admin/users/${encodeURIComponent(u.username)}/edit">Editar</a>
          <form method="post" action="/admin/users/${encodeURIComponent(u.username)}/delete" onsubmit="return confirm('¿Eliminar ${esc(u.username)}?')"><button class="danger">Eliminar</button></form>
        </td>
      </tr>`).join("");
    const u = esc(req.query.u ?? "");
    const flashes: Record<string, string> = {
      sent: `<div class="ok">✅ Usuario <b>${u}</b> guardado y credenciales enviadas por correo.</div>`,
      mailoff: `<div class="err">Usuario <b>${u}</b> guardado, pero el correo no está configurado (SENDGRID_API_KEY / MAIL_FROM). No se enviaron credenciales.</div>`,
      mailerr: `<div class="err">Usuario <b>${u}</b> guardado, pero falló el envío del correo. Revisa la auditoría.</div>`,
    };
    const flash = flashes[String(req.query.f ?? "")] ?? "";
    res.send(page("Usuarios", `
      <h1>Usuarios</h1>
      ${flash}
      ${searchBar("#tbl", "Buscar por usuario, correo, rol o empresa…", '<a class="btn" href="/admin/users/new">+ Nuevo usuario</a>')}
      <table id="tbl"><tr><th>Usuario</th><th>Correo</th><th>Rol</th><th>Empresas</th><th>Activo</th><th></th></tr>${rows}</table>`, admin));
  });

  r.get("/users/new", guard, (req, res) => {
    res.send(page("Nuevo usuario", userForm((req as any).admin, null), (req as any).admin));
  });

  r.get("/users/:username/edit", guard, (req, res) => {
    const u = cachedUsers().users.find((x) => x.username === req.params.username);
    if (!u) return res.redirect("/admin/users");
    res.send(page("Editar usuario", userForm((req as any).admin, u), (req as any).admin));
  });

  r.post("/users", guard, async (req, res) => {
    const b = req.body;
    const admin = (req as any).admin as string;
    const username = String(b.username).trim();
    const email = b.email ? String(b.email).trim() : undefined;
    const fullName = b.fullName ? String(b.fullName).trim() : undefined;
    const companies = ([] as string[]).concat(b.companies ?? []).filter(Boolean);
    const isNew = !cachedUsers().users.some((u) => u.username === username);

    // Contraseña: la escrita; si es nuevo y se dejó vacía, se genera una.
    let password = b.password ? String(b.password) : undefined;
    if (isNew && !password) password = generatePassword();

    await upsertUser({
      username, fullName, email,
      role: b.role,
      active: b.active === "on",
      allCompanies: b.allCompanies === "on",
      companies,
      password,
    });
    audit({ username: admin, role: "superadmin", action: "admin:user-upsert", outcome: "ok", target: username });

    // Enviar credenciales por correo (solo si hay email, contraseña conocida y se marcó la casilla).
    let flash = "";
    if (b.sendEmail === "on" && email && password) {
      if (!mailEnabled()) {
        flash = "mailoff";
      } else {
        try {
          const { subject, html } = credentialsEmail({ fullName, username, password, appUrl: config.mail.appUrl || undefined });
          await sendMail({ to: email, subject, html });
          audit({ username: admin, role: "superadmin", action: "admin:user-credentials-sent", outcome: "ok", target: username, detail: `a ${email}` });
          flash = "sent";
        } catch (e) {
          audit({ username: admin, role: "superadmin", action: "admin:user-credentials-sent", outcome: "error", target: username, detail: (e as Error).message });
          flash = "mailerr";
        }
      }
    }
    res.redirect(`/admin/users?u=${encodeURIComponent(username)}${flash ? `&f=${flash}` : ""}`);
  });

  r.post("/users/:username/delete", guard, async (req, res) => {
    await deleteUser(req.params.username);
    audit({ username: (req as any).admin, role: "superadmin", action: "admin:user-delete", outcome: "ok", target: req.params.username });
    res.redirect("/admin/users");
  });

  // ------------------------------- roles -------------------------------
  r.get("/roles", guard, (req, res) => {
    const admin = (req as any).admin as string;
    const roles = getRoles().roles;
    const rows = Object.entries(roles).map(([name, def]) => `
      <tr>
        <td><b>${esc(name)}</b><br><span class="muted">${esc(def.description ?? "")}</span></td>
        <td>${Object.entries(def.entities).map(([e, ops]) => `<span class="pill">${esc(e)}: ${ops.join("/")}</span>`).join(" ")}</td>
        <td class="actions">
          <a class="btn sec" href="/admin/roles/${encodeURIComponent(name)}/edit">Editar</a>
          ${name === "superadmin" || name === "admin" ? "" : `<form method="post" action="/admin/roles/${encodeURIComponent(name)}/delete" onsubmit="return confirm('¿Eliminar rol ${esc(name)}?')"><button class="danger">Eliminar</button></form>`}
        </td>
      </tr>`).join("");
    res.send(page("Roles", `
      <h1>Roles</h1>
      ${searchBar("#tbl", "Buscar rol o permiso…", '<a class="btn" href="/admin/roles/new">+ Nuevo rol</a>')}
      <table id="tbl"><tr><th>Rol</th><th>Permisos</th><th></th></tr>${rows}</table>`, admin));
  });

  r.get("/roles/new", guard, (req, res) => res.send(page("Nuevo rol", roleForm(null), (req as any).admin)));
  r.get("/roles/:name/edit", guard, (req, res) => {
    const def = getRoles().roles[req.params.name];
    if (!def) return res.redirect("/admin/roles");
    res.send(page("Editar rol", roleForm({ name: req.params.name, def }), (req as any).admin));
  });

  r.post("/roles", guard, async (req, res) => {
    const b = req.body;
    const name = String(b.name).trim();
    const perms: { entity: string; operation: Operation }[] = [];
    // checkboxes nombradas perm_<entity>_<op>
    for (const entity of [...ALL_ENTITIES, "*"]) {
      for (const op of OPS) {
        if (b[`perm_${entity}_${op}`] === "on") perms.push({ entity, operation: op });
      }
    }
    await upsertRole(name, b.description ?? "", perms);
    audit({ username: (req as any).admin, role: "superadmin", action: "admin:role-upsert", outcome: "ok", target: name });
    res.redirect("/admin/roles");
  });

  r.post("/roles/:name/delete", guard, async (req, res) => {
    await deleteRole(req.params.name);
    audit({ username: (req as any).admin, role: "superadmin", action: "admin:role-delete", outcome: "ok", target: req.params.name });
    res.redirect("/admin/roles");
  });

  // ------------------------------ empresas ------------------------------
  r.get("/companies", guard, (req, res) => {
    const admin = (req as any).admin as string;
    const rows = getAllCompanies().map((c) => `
      <tr><td><b>${esc(c.alias)}</b></td><td>${esc(c.label)}</td><td><code>${esc(c.companyDB)}</code></td>
        <td class="actions">
          <a class="btn sec" href="/admin/companies/${encodeURIComponent(c.alias)}/edit">Editar</a>
          <form method="post" action="/admin/companies/${encodeURIComponent(c.alias)}/delete" onsubmit="return confirm('¿Eliminar ${esc(c.alias)}?')"><button class="danger">Eliminar</button></form>
        </td></tr>`).join("");
    res.send(page("Empresas", `
      <h1>Empresas</h1>
      ${searchBar("#tbl", "Buscar por alias, nombre o CompanyDB…", '<a class="btn" href="/admin/companies/new">+ Nueva empresa</a>')}
      <table id="tbl"><tr><th>Alias</th><th>Nombre</th><th>CompanyDB</th><th></th></tr>${rows}</table>`, admin));
  });

  r.get("/companies/new", guard, (req, res) => res.send(page("Nueva empresa", companyForm(null), (req as any).admin)));
  r.get("/companies/:alias/edit", guard, (req, res) => {
    const c = getAllCompanies().find((x) => x.alias === req.params.alias);
    if (!c) return res.redirect("/admin/companies");
    res.send(page("Editar empresa", companyForm(c), (req as any).admin));
  });

  r.post("/companies", guard, async (req, res) => {
    const b = req.body;
    await upsertCompany({ alias: String(b.alias).trim(), label: b.label, companyDB: b.companyDB, url: b.url || undefined });
    audit({ username: (req as any).admin, role: "superadmin", action: "admin:company-upsert", outcome: "ok", target: b.alias });
    res.redirect("/admin/companies");
  });

  r.post("/companies/:alias/delete", guard, async (req, res) => {
    await deleteCompany(req.params.alias);
    audit({ username: (req as any).admin, role: "superadmin", action: "admin:company-delete", outcome: "ok", target: req.params.alias });
    res.redirect("/admin/companies");
  });

  // ------------------------------ auditoría ------------------------------
  r.get("/audit", guard, async (req, res) => {
    const admin = (req as any).admin as string;
    const q = req.query;
    const filter = {
      username: q.username ? String(q.username) : undefined,
      action: q.action ? String(q.action) : undefined,
      company: q.company ? String(q.company) : undefined,
      outcome: q.outcome ? String(q.outcome) : undefined,
      from: q.from ? String(q.from) : undefined,
      to: q.to ? String(q.to) : undefined,
      limit: 200,
    };
    const events = await queryAudit(filter);
    const badge = (o: string) => {
      const cls: Record<string, string> = { ok: "b-ok", denied: "b-denied", error: "b-error", pending: "b-pending", confirmed: "b-pending" };
      return `<span class="badge ${cls[o] ?? "b-mut"}">${esc(o || "—")}</span>`;
    };
    const prettyParams = (p: unknown): string => {
      if (p == null || p === "") return "";
      try {
        return JSON.stringify(typeof p === "string" ? JSON.parse(p) : p, null, 2);
      } catch {
        return String(p);
      }
    };
    const filterChip = (k: string, v?: string) =>
      v ? `<span class="pill">${esc(k)}: ${esc(v)} <a href="/admin/audit" style="color:inherit">✕</a></span>` : "";

    const rows = events
      .map((e) => {
        const params = prettyParams(e.params);
        const moreBody = [e.detail ? esc(e.detail) : "", params ? "params:\n" + esc(params) : ""].filter(Boolean).join("\n\n");
        const more = moreBody ? `<details class="au"><summary>ver detalle</summary><pre>${moreBody}</pre></details>` : "";
        const op = [e.entity, e.operation].filter(Boolean).map(esc).join(" · ");
        return `<tr>
          <td class="muted mono" style="white-space:nowrap">${esc(e.ts)}</td>
          <td><strong>${esc(e.username ?? "—")}</strong>${e.role ? `<br><span class="muted">${esc(e.role)}</span>` : ""}</td>
          <td>${esc(e.company ?? "")}</td>
          <td class="mono">${esc(e.action ?? "")}${op ? `<br><span class="muted">${op}</span>` : ""}</td>
          <td>${badge(e.outcome ?? "")}</td>
          <td class="mono">${esc(e.target ?? "")}</td>
          <td>${esc((e.detail ?? "").slice(0, 70))}${more}</td>
        </tr>`;
      })
      .join("");

    const activos = [
      filterChip("usuario", filter.username),
      filterChip("acción", filter.action),
      filterChip("empresa", filter.company),
      filterChip("resultado", filter.outcome),
    ].join(" ");

    res.send(page("Auditoría", `
      <h1>Auditoría</h1>
      <details class="card filters" ${activos.trim() ? "open" : ""}>
        <summary>Filtros del servidor</summary>
        <form method="get" action="/admin/audit">
          <div class="row">
            <div><label>Usuario</label><input name="username" value="${esc(q.username ?? "")}"></div>
            <div><label>Acción contiene</label><input name="action" value="${esc(q.action ?? "")}"></div>
            <div><label>Empresa</label><input name="company" value="${esc(q.company ?? "")}"></div>
            <div><label>Resultado</label><input name="outcome" value="${esc(q.outcome ?? "")}" placeholder="ok / denied / error / pending"></div>
          </div>
          <div class="row">
            <div><label>Desde</label><input name="from" type="datetime-local" value="${esc(q.from ?? "")}"></div>
            <div><label>Hasta</label><input name="to" type="datetime-local" value="${esc(q.to ?? "")}"></div>
            <div style="display:flex;align-items:flex-end;gap:8px"><button>Filtrar</button><a class="btn sec" href="/admin/audit">Limpiar</a></div>
          </div>
        </form>
      </details>
      ${activos.trim() ? `<div style="margin:8px 0">${activos}</div>` : ""}
      ${searchBar("#tbl", "Buscar en los resultados cargados…", `<span class="muted">${events.length} de máx. ${filter.limit} eventos</span>`)}
      <div class="table-scroll">
        <table id="tbl">
          <tr><th>Fecha</th><th>Usuario</th><th>Empresa</th><th>Acción</th><th>Resultado</th><th>Objeto</th><th>Detalle</th></tr>
          ${rows || '<tr class="no-results"><td colspan="7">Sin eventos</td></tr>'}
        </table>
      </div>`, admin));
  });

  return r;
}

// ------------------------------ formularios ------------------------------

function userForm(_admin: string, u: any | null): string {
  const roles = Object.keys(getRoles().roles);
  const companies = getAllCompanies();
  const sel = (u?.companies && u.companies !== "*") ? (u.companies as string[]) : [];
  const isNew = !u;
  return `
    <h1>${isNew ? "Nuevo usuario" : "Editar " + esc(u.username)}</h1>
    <form class="card" method="post" action="/admin/users">
      <div class="row">
        <div><label>Usuario</label><input name="username" value="${esc(u?.username ?? "")}" ${isNew ? "" : "readonly"} required></div>
        <div><label>Nombre completo</label><input name="fullName" value="${esc(u?.fullName ?? "")}"></div>
      </div>
      <div class="row">
        <div><label>Correo electrónico</label><input name="email" type="email" value="${esc(u?.email ?? "")}" placeholder="usuario@empresa.com"></div>
        <div><label>Rol</label><select name="role">${roles.map((rn) => `<option ${u?.role === rn ? "selected" : ""}>${esc(rn)}</option>`).join("")}</select></div>
      </div>
      <div class="row">
        <div><label>Contraseña ${isNew ? "(vacío = se genera una y se envía por correo)" : "(dejar vacío para no cambiar)"}</label><input name="password" type="text" autocomplete="new-password"></div>
        <div style="display:flex;align-items:flex-end">
          <label style="margin:0"><input type="checkbox" name="sendEmail" checked style="width:auto"> Enviar credenciales por correo</label>
        </div>
      </div>
      <label><input type="checkbox" name="active" ${u?.active === false ? "" : "checked"} style="width:auto"> Activo</label>
      <label><input type="checkbox" name="allCompanies" id="allc" ${(!u || u.companies === "*") ? "checked" : ""} style="width:auto" onchange="document.getElementById('cbox').style.display=this.checked?'none':'block'"> Acceso a TODAS las empresas</label>
      <div id="cbox" style="display:${(!u || u.companies === "*") ? "none" : "block"}">
        <label>Empresas permitidas</label>
        <select name="companies" multiple size="10">
          ${companies.map((c) => `<option value="${esc(c.alias)}" ${sel.includes(c.alias) ? "selected" : ""}>${esc(c.alias)} — ${esc(c.label)}</option>`).join("")}
        </select>
        <span class="muted">Ctrl/Cmd para seleccionar varias.</span>
      </div>
      <div style="margin-top:16px"><button>Guardar</button> <a class="btn sec" href="/admin/users">Cancelar</a></div>
    </form>`;
}

function roleForm(role: { name: string; def: any } | null): string {
  const isNew = !role;
  const has = (e: string, op: string) => !!role?.def?.entities?.[e]?.includes(op);
  const entRows = [...ALL_ENTITIES, "*"].map((e) => `
    <tr><td><b>${esc(e)}</b></td>${OPS.map((op) => `<td style="text-align:center"><input type="checkbox" name="perm_${esc(e)}_${op}" ${has(e, op) ? "checked" : ""} style="width:auto"></td>`).join("")}</tr>`).join("");
  return `
    <h1>${isNew ? "Nuevo rol" : "Editar rol " + esc(role!.name)}</h1>
    <form class="card" method="post" action="/admin/roles">
      <div class="row">
        <div><label>Nombre del rol</label><input name="name" value="${esc(role?.name ?? "")}" ${isNew ? "" : "readonly"} required></div>
        <div><label>Descripción</label><input name="description" value="${esc(role?.def?.description ?? "")}"></div>
      </div>
      <h2>Permisos por entidad</h2>
      <table><tr><th>Entidad</th><th>read</th><th>create</th><th>update</th></tr>${entRows}</table>
      <p class="muted"><code>*</code> = todas las entidades. <code>Financials</code> = estados financieros y conciliación.</p>
      <div style="margin-top:16px"><button>Guardar</button> <a class="btn sec" href="/admin/roles">Cancelar</a></div>
    </form>`;
}

function companyForm(c: any | null): string {
  const isNew = !c;
  return `
    <h1>${isNew ? "Nueva empresa" : "Editar " + esc(c.alias)}</h1>
    <form class="card" method="post" action="/admin/companies">
      <div class="row">
        <div><label>Alias (clave única)</label><input name="alias" value="${esc(c?.alias ?? "")}" ${isNew ? "" : "readonly"} required></div>
        <div><label>Nombre</label><input name="label" value="${esc(c?.label ?? "")}" required></div>
      </div>
      <div class="row">
        <div><label>CompanyDB (base SAP)</label><input name="companyDB" value="${esc(c?.companyDB ?? "")}" required></div>
        <div><label>URL Service Layer (opcional)</label><input name="url" value="${esc(c?.url ?? "")}" placeholder="usa SAP_SL_URL si se deja vacío"></div>
      </div>
      <div style="margin-top:16px"><button>Guardar</button> <a class="btn sec" href="/admin/companies">Cancelar</a></div>
    </form>`;
}
