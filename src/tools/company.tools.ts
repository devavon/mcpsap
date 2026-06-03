import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllCompanies, getCompany } from "../sap/companies.js";
import { selectCompany } from "../auth/session.js";
import { audit } from "../audit/logger.js";
import { text, wrap } from "./helpers.js";

export function registerCompanyTools(server: McpServer): void {
  server.registerTool(
    "list_companies",
    {
      title: "Listar empresas disponibles para el usuario",
      description:
        "Muestra las empresas (CompanyDB de SAP) a las que el usuario autenticado tiene acceso " +
        "e indica cuál está seleccionada actualmente.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap("list_companies", async (_args, user) => {
      const all = getAllCompanies();
      const mine = all.filter((c) => user.allowedCompanies.includes(c.alias));
      if (mine.length === 0) {
        return text("No tiene acceso a ninguna empresa. Contacte al administrador.");
      }
      const lines = mine.map((c) => {
        const sel = c.alias === user.selectedCompany ? "  ✅ (seleccionada)" : "";
        return `  • ${c.alias} — ${c.label} (DB: ${c.companyDB})${sel}`;
      });
      audit({ username: user.username, role: user.role, action: "list_companies", outcome: "ok" });
      return text(
        `Empresas disponibles para ${user.username}:\n${lines.join("\n")}\n\n` +
          (user.selectedCompany
            ? `Empresa activa: ${getCompany(user.selectedCompany).label}.`
            : `Aún no ha seleccionado empresa. Use 'select_company' con el alias deseado.`),
      );
    }),
  );

  server.registerTool(
    "select_company",
    {
      title: "Seleccionar la empresa activa",
      description:
        "Fija la empresa sobre la que se ejecutarán las siguientes operaciones. " +
        "Solo puede seleccionar empresas a las que tenga acceso (ver 'list_companies').",
      inputSchema: {
        company: z.string().min(1).describe("Alias de la empresa (ej. 'empresa1')"),
      },
    },
    wrap("select_company", async (args, user) => {
      selectCompany(user, args.company);
      const c = getCompany(user.selectedCompany!);
      audit({
        username: user.username,
        role: user.role,
        company: user.selectedCompany,
        action: "select_company",
        outcome: "ok",
      });
      return text(`✅ Empresa activa: ${c.label} (${c.alias}, DB: ${c.companyDB}).`);
    }),
  );
}
