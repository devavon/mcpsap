import hana from "@sap/hana-client";
import { config } from "../config.js";

/**
 * Conexión directa a SAP HANA para ejecutar informes SQL (consultas tipo
 * "User Query" de SAP B1) que el Service Layer no puede resolver (saldos de
 * pagos, conciliaciones, etc.).
 *
 * Cada empresa de B1 es un ESQUEMA de HANA (= CompanyDB). Antes de cada consulta
 * se fija el esquema con SET SCHEMA, de modo que las tablas sin prefijo (OINV,
 * ORIN, OJDT…) resuelvan contra la empresa seleccionada.
 *
 * Solo se usa para SELECT predefinidos y parametrizados (RBAC: rol con lectura
 * de "Financials"). No se ejecuta SQL arbitrario del usuario.
 */

export function hanaEnabled(): boolean {
  // El host se hereda del Service Layer; lo que realmente hay que definir es el
  // usuario y la clave de HANA (distintos a los de B1).
  return !!(config.hana.host && config.hana.user && config.hana.password);
}

export class HanaError extends Error {}

/** Nombre de esquema seguro (solo lo que usa SAP B1 en CompanyDB). */
function safeSchema(companyDB: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(companyDB)) {
    throw new HanaError(`CompanyDB inválida para HANA: ${companyDB}`);
  }
  return companyDB;
}

function exec<T = any>(conn: any, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn.exec(sql, params, (err: any, rows: T[]) => (err ? reject(err) : resolve(rows)));
  });
}

/**
 * HANA devuelve DECIMAL como texto ('3390.000000'). Convierte cadenas numéricas
 * a número para que Excel las trate como cifras (y pueda sumarlas), pero deja
 * como texto los IDs largos (>15 dígitos, p.ej. claves FE) para no perder dígitos.
 */
function coerce(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (/^-?\d+\.\d+$/.test(v)) return Number(v); // decimal
  if (/^-?\d{1,15}$/.test(v)) return Number(v); // entero seguro
  return v;
}

function coerceRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const r of rows) for (const k of Object.keys(r)) r[k] = coerce(r[k]);
  return rows;
}

/**
 * Ejecuta una consulta SQL parametrizada contra la empresa (esquema) indicada.
 * Abre y cierra una conexión por llamada (uso de baja frecuencia: informes).
 */
export async function runHanaQuery<T = Record<string, unknown>>(
  companyDB: string,
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  if (!hanaEnabled()) {
    throw new HanaError("HANA no está configurado (defina HANA_HOST, HANA_USER, HANA_PASSWORD).");
  }
  const schema = safeSchema(companyDB);
  const conn = hana.createConnection();

  await new Promise<void>((resolve, reject) => {
    conn.connect(
      {
        serverNode: `${config.hana.host}:${config.hana.port}`,
        uid: config.hana.user,
        pwd: config.hana.password,
        encrypt: config.hana.encrypt,
        sslValidateCertificate: config.hana.sslValidate,
        // Tiempos de espera razonables para no colgar el request.
        connectTimeout: 15000,
      },
      (err: any) => (err ? reject(new HanaError(`No se pudo conectar a HANA: ${err.message ?? err}`)) : resolve()),
    );
  });

  try {
    await exec(conn, `SET SCHEMA "${schema}"`);
    const rows = await exec<T>(conn, sql, params);
    return coerceRows(rows as Record<string, unknown>[]) as T[];
  } catch (e: any) {
    throw new HanaError(`Error ejecutando consulta HANA: ${e?.message ?? e}`);
  } finally {
    try {
      conn.disconnect(() => {});
    } catch {
      /* ignore */
    }
  }
}
