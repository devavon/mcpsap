import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.js";
import type { Operation } from "../types.js";

/**
 * Auditoría completa: registra TODA operación (lectura y escritura) en
 * archivos JSONL, uno por día (audit-YYYY-MM-DD.jsonl). Cada línea es un
 * evento independiente, fácil de ingerir en SIEM/ELK.
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
  if (fileLoggingDisabled) return;
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
