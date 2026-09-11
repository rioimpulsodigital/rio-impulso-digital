-- RIO-120 — Migración 0033 (11/09/2026)
-- Brenda redefinió y simplificó el alcance de RIO-120: se descarta la
-- Objects API (negocios, aplicación privada, token, propiedades
-- personalizadas, pipeline/etapas) y se restaura el mecanismo original
-- que sí entregaba el correo — envío del formulario "Ficha y Landing
-- Page - RiO" (Forms API), ahora disparado desde el NAVEGADOR (como
-- siempre fue, desde RIO-70/71/72) después de que la venta ya quedó
-- guardada en D1 (RIO-117/120), nunca antes.
--
-- NO es una reversión destructiva de la migración 0032: esa
-- infraestructura (columnas de negocio/canal 'objects_api', hash de
-- payload, descarte administrativo) queda tal cual, documentada como
-- infraestructura descartada/no utilizada — nunca se vuelve a poblar
-- desde el código nuevo, pero permanece disponible para auditoría de lo
-- que se construyó y por qué se abandonó (ver RIO-120 en Notion). Las 2
-- filas legacy de Forms API (1/09 y 3/09, marcadas como spam) tampoco se
-- tocan acá.
--
-- Único cambio de esquema real: el CHECK de `canal` no admitía un valor
-- para "envío desde el navegador, con registro mínimo" — se agrega
-- 'forms_api_browser'. SQLite no permite ALTERar un CHECK existente, se
-- reconstruye con el mismo patrón ya usado en todo el proyecto (crear
-- nueva, copiar, borrar, renombrar) — ninguna fila existente cambia de
-- valor ni se pierde.
PRAGMA foreign_keys=off;

CREATE TABLE hubspot_sync_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN (
    'legacy_form_accepted', 'pendiente', 'procesando', 'sincronizado',
    'error', 'reintento_pendiente', 'descartado', 'enviado'
  )),
  canal TEXT NOT NULL DEFAULT 'forms_api_browser' CHECK (canal IN ('forms_api_legacy', 'objects_api', 'forms_api_browser')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_intento_at TEXT,
  proximo_reintento_at TEXT,
  ultima_respuesta_resumen TEXT,
  hubspot_contact_id TEXT,
  hubspot_deal_id TEXT,
  payload_hash TEXT,
  motivo_descarte TEXT,
  descartado_por TEXT,
  descartado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO hubspot_sync_new SELECT * FROM hubspot_sync;
DROP TABLE hubspot_sync;
ALTER TABLE hubspot_sync_new RENAME TO hubspot_sync;
CREATE UNIQUE INDEX idx_hubspot_sync_venta ON hubspot_sync (venta_id);
CREATE INDEX idx_hubspot_sync_estado ON hubspot_sync (estado);

PRAGMA foreign_keys=on;
