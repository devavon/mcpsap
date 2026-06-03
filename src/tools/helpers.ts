import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UserContext } from "../types.js";
import { requireUser } from "../auth/session.js";
import { audit } from "../audit/logger.js";
import { SapError } from "../sap/serviceLayer.js";
import { PermissionError } from "../auth/roles.js";
import { AuthError } from "../auth/session.js";

/** Texto plano como resultado de herramienta. */
export function text(content: string): CallToolResult {
  return { content: [{ type: "text", text: content }] };
}

/** JSON formateado como resultado. */
export function json(label: string, data: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: `${label}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` },
    ],
  };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `❌ ${message}` }] };
}

/** Resuelve el usuario autenticado a partir del sessionId del transporte. */
export function userFrom(extra: { sessionId?: string }): UserContext {
  return requireUser(extra.sessionId);
}

/**
 * Envuelve un handler de herramienta:
 *  - resuelve usuario (si requireAuth)
 *  - captura errores conocidos y los convierte en resultados legibles
 *  - registra en auditoría el outcome
 */
export function wrap(
  toolName: string,
  handler: (args: any, user: UserContext, extra: any) => Promise<CallToolResult>,
  opts: { requireAuth?: boolean } = { requireAuth: true },
) {
  return async (args: any, extra: any): Promise<CallToolResult> => {
    let user: UserContext | undefined;
    try {
      if (opts.requireAuth !== false) {
        user = userFrom(extra);
      }
      return await handler(args, user as UserContext, extra);
    } catch (e) {
      const username = user?.username ?? "(anónimo)";
      const role = user?.role ?? "-";
      if (e instanceof AuthError) {
        audit({ username, role, action: toolName, outcome: "denied", detail: e.message });
        return errorResult(e.message);
      }
      if (e instanceof PermissionError) {
        audit({ username, role, action: toolName, outcome: "denied", detail: e.message });
        return errorResult(e.message);
      }
      if (e instanceof SapError) {
        audit({
          username,
          role,
          action: toolName,
          outcome: "error",
          detail: `SAP ${e.status}${e.sapCode ? ` [${e.sapCode}]` : ""}: ${e.message}`,
        });
        return errorResult(`SAP respondió error (${e.status}): ${e.message}`);
      }
      const msg = (e as Error).message ?? String(e);
      audit({ username, role, action: toolName, outcome: "error", detail: msg });
      return errorResult(msg);
    }
  };
}
