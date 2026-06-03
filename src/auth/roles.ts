import type { Operation, UserContext } from "../types.js";
import { getRole } from "./store.js";

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/**
 * Verifica si un rol puede ejecutar `op` sobre `entity`.
 * Soporta la entidad comodín "*".
 */
export function roleAllows(roleName: string, entity: string, op: Operation): boolean {
  const role = getRole(roleName);
  if (!role) return false;
  const ents = role.entities;
  const wildcard = ents["*"];
  if (wildcard && wildcard.includes(op)) return true;
  const specific = ents[entity];
  return !!specific && specific.includes(op);
}

/** Lanza PermissionError si el usuario no tiene el permiso requerido. */
export function assertPermission(
  user: UserContext,
  entity: string,
  op: Operation,
): void {
  if (!roleAllows(user.role, entity, op)) {
    throw new PermissionError(
      `Permiso denegado: el rol "${user.role}" no puede "${op}" sobre "${entity}". ` +
        `Contacte al administrador si necesita este acceso.`,
    );
  }
}

/** Lista de entidades sobre las que el rol tiene al menos lectura. */
export function readableEntities(roleName: string, allEntities: string[]): string[] {
  return allEntities.filter((e) => roleAllows(roleName, e, "read"));
}

/** Resumen de permisos del rol, para mostrarlo al usuario tras el login. */
export function describePermissions(roleName: string): string {
  const role = getRole(roleName);
  if (!role) return `Rol "${roleName}" no encontrado.`;
  const lines = Object.entries(role.entities).map(
    ([ent, ops]) => `  • ${ent}: ${ops.join(", ")}`,
  );
  return `Rol "${roleName}"${role.description ? ` (${role.description})` : ""}:\n${lines.join("\n")}`;
}
