import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import type { UsersConfig, RolesConfig } from "../types.js";

/**
 * CLI para crear/actualizar usuarios del MCP.
 *
 * Uso:
 *   npm run useradd -- <usuario> <rol> ["Nombre Completo"] [empresas]
 *
 * "empresas" es opcional: lista de aliases separados por coma (ej. "empresa1,empresa2")
 * o "*" para todas. Si se omite, el usuario tendrá acceso a TODAS las empresas.
 *
 * Pide la contraseña por entrada estándar y guarda el hash bcrypt en
 * config/users.json.
 */

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolveP) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Intentar ocultar la entrada.
    const stdin = process.stdin as any;
    const onData = (char: Buffer) => {
      const s = char.toString();
      if (s === "\n" || s === "\r" || s === "") {
        stdin.removeListener("data", onData);
      } else {
        // Reescribe la línea ocultando los caracteres.
        process.stdout.write("\x1b[2K\r" + prompt + "*".repeat(rl.line.length));
      }
    };
    stdin.on("data", onData);
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolveP(answer);
    });
  });
}

async function main() {
  const [username, role, fullName, companiesArg] = process.argv.slice(2);
  if (!username || !role) {
    console.error('Uso: npm run useradd -- <usuario> <rol> ["Nombre Completo"] [empresas]');
    console.error('  empresas: aliases separados por coma (ej. "empresa1,empresa2") o "*" (todas).');
    process.exit(1);
  }

  // Validar que el rol exista.
  const rolesPath = resolve(config.files.rolesFile);
  const roles = JSON.parse(readFileSync(rolesPath, "utf8")) as RolesConfig;
  if (!roles.roles[role]) {
    console.error(
      `El rol "${role}" no existe en ${rolesPath}. Roles disponibles: ${Object.keys(roles.roles).join(", ")}`,
    );
    process.exit(1);
  }

  const pwd = await readPassword(`Contraseña para "${username}": `);
  if (pwd.length < 6) {
    console.error("La contraseña debe tener al menos 6 caracteres.");
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(pwd, 10);

  const usersPath = resolve(config.files.usersFile);
  let usersCfg: UsersConfig = { users: [] };
  if (existsSync(usersPath)) {
    usersCfg = JSON.parse(readFileSync(usersPath, "utf8")) as UsersConfig;
    if (!Array.isArray(usersCfg.users)) usersCfg.users = [];
  } else {
    mkdirSync(dirname(usersPath), { recursive: true });
  }

  const idx = usersCfg.users.findIndex(
    (u) => u.username.toLowerCase() === username.toLowerCase(),
  );
  // Empresas: "*" (o vacío) => todas; si no, lista por coma.
  let companies: string[] | "*" = "*";
  if (companiesArg && companiesArg.trim() !== "*" && companiesArg.trim() !== "") {
    companies = companiesArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const record = {
    username,
    fullName: fullName ?? username,
    role,
    passwordHash,
    active: true,
    companies,
  };
  if (idx >= 0) {
    usersCfg.users[idx] = record;
    console.error(`Usuario "${username}" actualizado.`);
  } else {
    usersCfg.users.push(record);
    console.error(`Usuario "${username}" creado con rol "${role}".`);
  }

  writeFileSync(usersPath, JSON.stringify(usersCfg, null, 2) + "\n", "utf8");
  console.error(`Guardado en ${usersPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
