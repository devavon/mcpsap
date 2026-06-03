import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import type { RolesConfig, UsersConfig, UserRecord, RoleDef } from "../types.js";

/**
 * Carga (y cachea) los archivos de configuración de roles y usuarios.
 * Se recargan si el archivo cambió (mtime), para permitir edición en caliente
 * sin reiniciar el servidor.
 */

let rolesCache: { mtime: number; data: RolesConfig } | null = null;
let usersCache: { mtime: number; data: UsersConfig } | null = null;
let rolesEnvCache: RolesConfig | null = null;
let usersEnvCache: UsersConfig | null = null;

function loadJson<T>(path: string): { mtime: number; data: T } {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`No existe el archivo de configuración: ${abs}`);
  }
  const { mtimeMs } = statSync(abs);
  const data = JSON.parse(readFileSync(abs, "utf8")) as T;
  return { mtime: mtimeMs, data };
}

export function getRoles(): RolesConfig {
  if (process.env.ROLES_JSON) {
    if (!rolesEnvCache) rolesEnvCache = JSON.parse(process.env.ROLES_JSON) as RolesConfig;
    return rolesEnvCache;
  }
  const abs = resolve(config.files.rolesFile);
  const { mtimeMs } = statSync(abs);
  if (!rolesCache || rolesCache.mtime !== mtimeMs) {
    rolesCache = loadJson<RolesConfig>(config.files.rolesFile);
  }
  return rolesCache.data;
}

export function getUsers(): UsersConfig {
  if (process.env.USERS_JSON) {
    if (!usersEnvCache) usersEnvCache = JSON.parse(process.env.USERS_JSON) as UsersConfig;
    return usersEnvCache;
  }
  const abs = resolve(config.files.usersFile);
  if (!existsSync(abs)) {
    throw new Error(
      `No existe ${abs} ni la variable USERS_JSON. Cree usuarios con: npm run useradd -- <usuario> <rol>`,
    );
  }
  const { mtimeMs } = statSync(abs);
  if (!usersCache || usersCache.mtime !== mtimeMs) {
    usersCache = loadJson<UsersConfig>(config.files.usersFile);
  }
  return usersCache.data;
}

export function findUser(username: string): UserRecord | undefined {
  return getUsers().users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
}

export function getRole(roleName: string): RoleDef | undefined {
  return getRoles().roles[roleName];
}

/** Invalida cachés. */
export function clearCaches(): void {
  rolesCache = null;
  usersCache = null;
}
