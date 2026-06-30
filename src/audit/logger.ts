import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.js";
import type { Operation } from "../types.js";
import { dbEnabled } from "../db/mysql.js";
import { insertAudit } from "../db/repo.js";

/**
 * Auditoría completa: registra TODA operación (lectura y escritura).
 *
 * Destinos:
 *  - MySQL (tabla mcp_audit) cuando hay DATABASE_URL → fuente persistente y la
 *    que muestra el panel /admin.
 *  - Archivo JSONL por día (audit-YYYY-MM-DD.jsonl) SOLO cuando no hay DB (o si
 *    se fuerza con AUDIT_FILE=true). Útil para ingerir en SIEM/ELK sin DB.
 *  - stdout opcional (AUDIT_STDOUT=true) para agregadores de logs.
 *
 * Así, con base de datos no se duplica en disco (que además es efímero en la
 * nube): la auditoría vive en MySQL.
 */

export interface AuditEvent {
  ts: string; // ISO timestamp
  username: string;
  role: string;
  /** Empresa (alias) sobre la que se operó. */
  company?: string;
  action: string; // nombre de la herramienta MCP
  entity?: string;
  operation?: Operation;
  /** "ok" | "denied" | "error" | "pending" | "confirmed" | "cancelled" */
  outcome: string;
  /** Identificador del recurso afectado (CardCode, DocEntry, pendingId...). */
  target?: string | number;
  detail?: string;
  /** Resumen del payload (sin secretos). */
  payload?: unknown;
}

let dirReady = false;
// Si el entorno no permite escribir a disco (p. ej. FS de solo lectura),
// se desactiva el log a archivo tras el primer fallo para no llenar stderr.
let fileLoggingDisabled = false;

/** ¿Se debe escribir el JSONL en disco? Por defecto: solo si NO hay DB. */
function fileLoggingEnabled(): boolean {
  if (config.audit.file === "true") return true;
  if (config.audit.file === "false") return false;
  return !dbEnabled(); // "auto"
}

function ensureDir(): string {
  const dir = resolve(config.audit.dir);
  if (!dirReady) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    dirReady = true;
  }
  return dir;
}

function fileForToday(): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(ensureDir(), `audit-${day}.jsonl`);
}

export function audit(event: Omit<AuditEvent, "ts">): void {
  const full: AuditEvent = { ts: new Date().toISOString(), ...event };
  const line = JSON.stringify(full);
  if (config.audit.stdout) {
    console.log(`[audit] ${line}`);
  }
  // Persistencia en MySQL (no bloqueante) cuando está habilitada.
  if (dbEnabled()) {
    insertAudit({ ...full, params: full.payload }).catch((e) =>
      console.error("[audit] fallo al insertar en DB:", (e as Error).message),
    );
  }
  if (fileLoggingDisabled || !fileLoggingEnabled()) return;
  try {
    appendFileSync(fileForToday(), line + "\n", "utf8");
  } catch (e) {
    // Nunca debe tumbar una operación por fallo de log. Si no se puede escribir
    // a disco, lo avisamos UNA vez y seguimos solo con stdout.
    fileLoggingDisabled = true;
    console.error(
      `[audit] log a archivo deshabilitado (${(e as Error).message}). ` +
        `${config.audit.stdout ? "Se mantiene el log a stdout." : "Active AUDIT_STDOUT=true para conservar la auditoría."}`,
    );
  }
}
