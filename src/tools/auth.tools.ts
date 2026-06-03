import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { login, logout, getSessionUser } from "../auth/session.js";
import { describePermissions } from "../auth/roles.js";
import { getCompany } from "../sap/companies.js";
import { audit } from "../audit/logger.js";
import { text, errorResult, wrap } from "./helpers.js";

/** Texto que describe el estado de empresa de la sesión. */
function companyStatus(user: { allowedCompanies: string[]; selectedCompany?: string }): string {
  if (user.allowedCompanies.length === 0) {
    return "⚠️ No tiene acceso a ninguna empresa. Contacte al administrador.";
  }
  if (user.selectedCompany) {
    const c = getCompany(user.selectedCompany);
    if (user.allowedCompanies.length === 1) {
      return `Empresa activa (única): ${c.label} (${c.alias}).`;
    }
    return `Empresa activa: ${c.label} (${c.alias}). Cámbiela con 'select_company' si lo necesita.`;
  }
  const aliases = user.allowedCompanies.join(", ");
  return `Tiene acceso a varias empresas (${aliases}). Use 'list_companies' y luego 'select_company' antes de operar.`;
}

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "login",
    {
      title: "Iniciar sesión en el MCP de SAP",
      description:
        "Autentica al usuario en el conector de SAP B1 con su usuario y contraseña del MCP. " +
        "Debe ejecutarse antes de cualquier otra operación. Determina el rol y los permisos del usuario.",
      inputSchema: {
        username: z.string().min(1).describe("Nombre de usuario del MCP"),
        password: z.string().min(1).describe("Contraseña del MCP"),
      },
    },
    async (args, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return errorResult(
          "No hay sessionId de transporte. El servidor debe ejecutarse con StreamableHTTP (sesiones habilitadas).",
        );
      }
      try {
        const ctx = await login(sessionId, args.username, args.password);
        audit({
          username: ctx.username,
          role: ctx.role,
          action: "login",
          outcome: "ok",
        });
        return text(
          `✅ Sesión iniciada como ${ctx.fullName} (usuario: ${ctx.username}).\n\n` +
            describePermissions(ctx.role) +
            `\n\n${companyStatus(ctx)}` +
            `\n\nNota: toda creación o edición de documentos requerirá su confirmación antes de enviarse a SAP.`,
        );
      } catch (e) {
        audit({
          username: args.username,
          role: "-",
          action: "login",
          outcome: "denied",
          detail: (e as Error).message,
        });
        return errorResult((e as Error).message);
      }
    },
  );

  server.registerTool(
    "logout",
    {
      title: "Cerrar sesión en el MCP",
      description: "Cierra la sesión actual del usuario en el conector.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const u = getSessionUser(extra.sessionId);
      logout(extra.sessionId);
      if (u) audit({ username: u.username, role: u.role, action: "logout", outcome: "ok" });
      return text("👋 Sesión cerrada.");
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Ver sesión actual y permisos",
      description:
        "Muestra el usuario autenticado, su rol y el detalle de permisos por entidad.",
      inputSchema: {},
    },
    wrap("whoami", async (_args, user) => {
      audit({ username: user.username, role: user.role, action: "whoami", outcome: "ok" });
      return text(
        `Usuario: ${user.fullName} (${user.username})\n` +
          describePermissions(user.role) +
          `\n\n${companyStatus(user)}`,
      );
    }),
  );
}
