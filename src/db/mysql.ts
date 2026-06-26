import mysql, { type Pool } from "mysql2/promise";
import { config } from "../config.js";

/**
 * Capa de acceso a MySQL. Solo se activa si DATABASE_URL está definida.
 * Cuando está activa, MySQL es la fuente de verdad de usuarios, roles,
 * empresas y auditoría, y se habilita el panel /admin.
 */

let pool: Pool | null = null;

export function dbEnabled(): boolean {
  return !!config.db.url;
}

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: config.db.url,
      connectionLimit: 5,
      namedPlaceholders: true,
      dateStrings: true,
    });
  }
  return pool;
}

export async function query<T = any>(sql: string, params?: any): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}

/** Crea las tablas si no existen. Idempotente. */
export async function initSchema(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS mcp_roles (
       name VARCHAR(64) PRIMARY KEY,
       description VARCHAR(255)
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_role_permissions (
       role VARCHAR(64) NOT NULL,
       entity VARCHAR(64) NOT NULL,
       operation VARCHAR(16) NOT NULL,
       PRIMARY KEY (role, entity, operation)
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_companies (
       alias VARCHAR(64) PRIMARY KEY,
       label VARCHAR(255) NOT NULL,
       company_db VARCHAR(128) NOT NULL,
       url VARCHAR(255) NULL
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_users (
       username VARCHAR(64) PRIMARY KEY,
       full_name VARCHAR(255) NULL,
       password_hash VARCHAR(255) NOT NULL,
       role VARCHAR(64) NOT NULL,
       active TINYINT(1) NOT NULL DEFAULT 1,
       all_companies TINYINT(1) NOT NULL DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_user_companies (
       username VARCHAR(64) NOT NULL,
       company_alias VARCHAR(64) NOT NULL,
       PRIMARY KEY (username, company_alias)
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_audit (
       id BIGINT AUTO_INCREMENT PRIMARY KEY,
       ts DATETIME(3) NOT NULL,
       username VARCHAR(64) NULL,
       role VARCHAR(64) NULL,
       company VARCHAR(64) NULL,
       action VARCHAR(128) NULL,
       entity VARCHAR(64) NULL,
       operation VARCHAR(16) NULL,
       outcome VARCHAR(16) NULL,
       target VARCHAR(128) NULL,
       detail TEXT NULL,
       params TEXT NULL,
       INDEX idx_ts (ts),
       INDEX idx_user (username),
       INDEX idx_action (action),
       INDEX idx_company (company)
     )`,
  ];
  for (const sql of statements) {
    await getPool().query(sql);
  }
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end().catch(() => {});
  pool = null;
}
