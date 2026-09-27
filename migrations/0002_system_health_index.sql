-- RIO-110 — Migración 0002
-- Demuestra que una migración nueva puede agregarse sin editar la 0001.
-- Índice sobre checked_at para que /interno/api/health pueda consultar el
-- último registro sin escanear toda la tabla a medida que crezca.

CREATE INDEX IF NOT EXISTS idx_system_health_checked_at
  ON _system_health (checked_at);
