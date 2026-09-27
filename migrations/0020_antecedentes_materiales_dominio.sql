-- RIO-117 (correcciones tras validación real, 01/09/2026):
--   1. Antecedentes del Kit estructurados y categorizados (en vez de un
--      único bloque de texto en el historial) — ventas.antecedentes_kit_json.
--   2. Materiales informados por el vendedor y confirmados por
--      administración, con detalle auditable (qué, quién, cuándo,
--      observaciones) — separado de la máquina de estados ya existente en
--      componentes.materiales_estado (RIO-113), que no se toca.
--   3. costos_directos.monto pasa a admitir 0 (dominio propio del cliente,
--      RiO no asume costo — "registrar costo 0 con motivo auditable").
--      SQLite no permite ALTER de un CHECK existente: se reconstruye la
--      tabla (es hoja, sin FKs entrantes) siguiendo el mismo patrón usado
--      en migraciones anteriores para este tipo de cambio.

ALTER TABLE ventas ADD COLUMN antecedentes_kit_json TEXT;

CREATE TABLE IF NOT EXISTS materiales_informados_detalle (
  id TEXT PRIMARY KEY,
  componente_id TEXT NOT NULL REFERENCES componentes(id),
  informado_por TEXT NOT NULL,
  elementos_json TEXT NOT NULL, -- ej. '["logo","fotos"]'
  observaciones TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_materiales_informados_componente ON materiales_informados_detalle (componente_id);

CREATE TABLE IF NOT EXISTS materiales_confirmaciones (
  id TEXT PRIMARY KEY,
  componente_id TEXT NOT NULL REFERENCES componentes(id),
  admin_email TEXT NOT NULL,
  resultado TEXT NOT NULL CHECK (resultado IN ('completos', 'incompletos')),
  faltantes_json TEXT, -- solo cuando resultado = 'incompletos'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_materiales_confirmaciones_componente ON materiales_confirmaciones (componente_id);

CREATE TABLE costos_directos_new (
  id TEXT PRIMARY KEY,
  componente_id TEXT NOT NULL REFERENCES componentes(id),
  tipo TEXT NOT NULL,
  monto INTEGER NOT NULL CHECK (monto >= 0),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  autorizado_por TEXT NOT NULL,
  nota TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO costos_directos_new SELECT * FROM costos_directos;
DROP TABLE costos_directos;
ALTER TABLE costos_directos_new RENAME TO costos_directos;
CREATE INDEX IF NOT EXISTS idx_costos_directos_componente ON costos_directos (componente_id);
