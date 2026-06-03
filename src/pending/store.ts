import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { PendingAction } from "../types.js";

/**
 * Almacén en memoria de acciones de escritura pendientes de confirmación.
 *
 * Toda operación de crear/editar genera una acción pendiente con un resumen
 * legible; el usuario debe confirmarla explícitamente (confirm_action) antes
 * de que se ejecute contra SAP. Esto implementa "confirmación previa siempre".
 */

const pending = new Map<string, PendingAction>();

export function createPending(
  input: Omit<PendingAction, "id" | "createdAt" | "expiresAt">,
): PendingAction {
  const now = Date.now();
  const action: PendingAction = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    expiresAt: now + config.security.pendingTtlMs,
  };
  pending.set(action.id, action);
  return action;
}

/** Obtiene una acción pendiente válida del usuario dueño. Limpia si expiró. */
export function getPending(id: string, username: string): PendingAction | undefined {
  const a = pending.get(id);
  if (!a) return undefined;
  if (Date.now() > a.expiresAt) {
    pending.delete(id);
    return undefined;
  }
  // Solo el usuario que la creó puede confirmarla.
  if (a.username !== username) return undefined;
  return a;
}

export function removePending(id: string): void {
  pending.delete(id);
}

export function sweepPending(): void {
  const now = Date.now();
  for (const [id, a] of pending) {
    if (now > a.expiresAt) pending.delete(id);
  }
}
