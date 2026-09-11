-- RIO-120 — Migración 0032 (11/09/2026)
-- Reemplaza el CONTRATO de datos del mecanismo temporal de Forms API
-- (RIO-117) por el de la integración real server-to-server con la Objects
-- API de HubSpot.
--
-- Causa confirmada de la incidencia (Brenda verificó directamente en
-- HubSpot, 11/09/2026): los dos envíos existentes (1/09 y 3/09) SÍ
-- llegaron al formulario "Ficha y Landing Page - RiO", pero HubSpot los
-- clasificó como spam ("Dominio de sitio sin registrar" — origen
-- *.pages.dev de Preview). Un `200 OK` de la Forms API nunca fue prueba
-- real de que un contacto/negocio quedara creado — exactamente el motivo
-- por el que RIO-120 reemplaza esa API por una que sí confirma el objeto
-- creado (Objects API, con IDs reales de respuesta).
--
-- Esas 2 filas NO se tocan ni se reenvían — se preservan y se
-- reetiquetan como 'legacy_form_accepted' (canal 'forms_api_legacy') para
-- distinguirlas para siempre del nuevo estado confirmado por Objects API
-- (canal 'objects_api'). Verificado antes de aplicar: exactamente 2 filas
-- existentes en Preview (ver informe RIO-120 para el detalle completo).
--
-- SQLite no permite ALTERar un CHECK existente — se reconstruye con el
-- mismo patrón ya usado en todo el proyecto (crear nueva, copiar, borrar,
-- renombrar).
PRAGMA foreign_keys=off;

CREATE TABLE hubspot_sync_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  -- 'legacy_form_accepted': envío histórico vía Forms API, aceptado por
  --   HTTP pero SIN confirmación real de objeto creado — ver nota arriba.
  -- 'pendiente': recién creado, todavía no se intentó la sincronización real.
  -- 'procesando': intento en curso (evita reintentos concurrentes).
  -- 'sincronizado': contacto Y negocio confirmados por Objects API (con sus IDs).
  -- 'error': el intento más reciente falló — ver ultima_respuesta_resumen.
  -- 'reintento_pendiente': falló pero hay un próximo reintento programado.
  -- 'descartado': administración decidió no seguir intentando (motivo_descarte obligatorio).
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN (
    'legacy_form_accepted', 'pendiente', 'procesando', 'sincronizado',
    'error', 'reintento_pendiente', 'descartado'
  )),
  -- Distingue el mecanismo que produjo el resultado — nunca se infiere
  -- del estado solo (un 'error' puede venir de cualquiera de los dos).
  canal TEXT NOT NULL DEFAULT 'objects_api' CHECK (canal IN ('forms_api_legacy', 'objects_api')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_intento_at TEXT,
  proximo_reintento_at TEXT,
  -- Resumen SIEMPRE seguro para mostrar a Administración — nunca la
  -- respuesta cruda de HubSpot (podría incluir datos internos de la
  -- cuenta). Ver saneamiento en functions/_shared/hubspot.js.
  ultima_respuesta_resumen TEXT,
  hubspot_contact_id TEXT,
  hubspot_deal_id TEXT,
  -- Hash del payload realmente enviado — permite detectar si una venta
  -- cambió desde el último intento sin tener que releerlo entero.
  payload_hash TEXT,
  motivo_descarte TEXT,
  descartado_por TEXT,
  descartado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO hubspot_sync_new (id, venta_id, estado, canal, intentos, ultimo_intento_at, ultima_respuesta_resumen, created_at, updated_at)
  SELECT id, venta_id,
    CASE WHEN estado = 'exitoso' THEN 'legacy_form_accepted' ELSE estado END,
    'forms_api_legacy', intentos, updated_at, ultima_respuesta_resumen, created_at, updated_at
  FROM hubspot_sync;
DROP TABLE hubspot_sync;
ALTER TABLE hubspot_sync_new RENAME TO hubspot_sync;
-- Único por venta: la venta identifica de forma unívoca su intento de
-- sincronización — impide dos filas (y por lo tanto ambigüedad) para la
-- misma venta.
CREATE UNIQUE INDEX idx_hubspot_sync_venta ON hubspot_sync (venta_id);
CREATE INDEX idx_hubspot_sync_estado ON hubspot_sync (estado);

PRAGMA foreign_keys=on;

-- eventos_historial: agrega 'hubspot_sync' como entidad auditable — cada
-- intento (creado, reintentado, sincronizado, error, descartado) queda
-- registrado con el mismo mecanismo append-only que ya usa todo el
-- sistema (logEvento), sin inventar un historial paralelo. Mismo patrón
-- de reconstrucción ya usado en 0010/0013/0016/0025.
PRAGMA foreign_keys=off;

CREATE TABLE eventos_historial_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT,
  entidad TEXT NOT NULL CHECK (entidad IN (
    'venta', 'proyecto', 'componente', 'pago', 'incidencia', 'comision', 'conversion', 'liquidacion', 'comprobante',
    'usuario', 'asignacion_rol', 'equipo', 'equipo_miembro', 'equipo_supervisor', 'plan_comision', 'asignacion_plan_comision',
    'hubspot_sync'
  )),
  entidad_id TEXT NOT NULL,
  estado_anterior TEXT,
  estado_nuevo TEXT NOT NULL,
  usuario_email TEXT NOT NULL,
  motivo_nota TEXT,
  proxima_accion TEXT,
  responsable_proxima_accion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO eventos_historial_new SELECT * FROM eventos_historial;
DROP TABLE eventos_historial;
ALTER TABLE eventos_historial_new RENAME TO eventos_historial;

PRAGMA foreign_keys=on;

-- notificaciones: agrega los 2 tipos que Brenda pidió como obligatorios
-- ("cuando se registre una venta y cuando cambie el estado de
-- sincronización") — mismo patrón de reconstrucción, primera vez que se
-- toca esta tabla desde 0017.
PRAGMA foreign_keys=off;

CREATE TABLE notificaciones_new (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'pago_informado', 'comprobante_nueva_version', 'venta_registrada', 'hubspot_sync_estado_cambiado'
  )),
  clave_idempotencia TEXT NOT NULL UNIQUE,
  venta_id TEXT REFERENCES ventas(id),
  pago_id TEXT,
  mercado TEXT,
  cliente_negocio TEXT,
  vendedor_email TEXT,
  ruta_portal TEXT NOT NULL,
  destinatario_rol TEXT NOT NULL DEFAULT 'admin' CHECK (destinatario_rol IN ('admin')),
  leida_en TEXT,
  leida_por TEXT,
  atendida_en TEXT,
  atendida_por TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO notificaciones_new SELECT * FROM notificaciones;
DROP TABLE notificaciones;
ALTER TABLE notificaciones_new RENAME TO notificaciones;
CREATE INDEX IF NOT EXISTS idx_notificaciones_pendientes ON notificaciones (destinatario_rol, atendida_en);

PRAGMA foreign_keys=on;
