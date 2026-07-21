-- ============================================================
--  Migración: credenciales SAP propias por empresa
--  Agrega sap_user y sap_password a mcp_companies (si faltan).
--  Idempotente. La app también lo aplica solo al arrancar.
--  Uso:  mysql -h HOST -u USER -p NOMBRE_BASE < add-company-sap-creds.sql
-- ============================================================

SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_companies' AND COLUMN_NAME='sap_user');
SET @s1 := IF(@c1=0,
  'ALTER TABLE `mcp_companies` ADD COLUMN `sap_user` VARCHAR(128) NULL',
  'SELECT ''sap_user ya existe'' AS info');
PREPARE st1 FROM @s1; EXECUTE st1; DEALLOCATE PREPARE st1;

SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_companies' AND COLUMN_NAME='sap_password');
SET @s2 := IF(@c2=0,
  'ALTER TABLE `mcp_companies` ADD COLUMN `sap_password` VARCHAR(255) NULL',
  'SELECT ''sap_password ya existe'' AS info');
PREPARE st2 FROM @s2; EXECUTE st2; DEALLOCATE PREPARE st2;
