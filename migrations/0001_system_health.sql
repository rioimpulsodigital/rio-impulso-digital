-- RIO-110 — Migración 0001
-- Entidad técnica mínima para verificar que D1 y las migraciones funcionan.
-- Sin datos personales ni lógica comercial (eso es RIO-111 en adelante,
-- fuera de alcance de esta fundación — ver RIO-97).

CREATE TABLE IF NOT EXISTS _system_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT NOT NULL
);
