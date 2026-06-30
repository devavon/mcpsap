-- ============================================================
--  Migración: agrega la columna `email` a mcp_users
--  (En la app esto se aplica AUTOMÁTICAMENTE al arrancar; este
--   script es por si prefieres correrlo manualmente en producción.)
--  Compatible con MySQL 5.7/8 y MariaDB. Idempotente.
--  Uso:  mysql -h HOST -u USER -p NOMBRE_BASE < add-user-email.sql
-- ============================================================

SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'mcp_users'
    AND COLUMN_NAME  = 'email'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE `mcp_users` ADD COLUMN `email` VARCHAR(255) NULL AFTER `full_name`',
  'SELECT ''La columna email ya existe, nada que hacer'' AS info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
