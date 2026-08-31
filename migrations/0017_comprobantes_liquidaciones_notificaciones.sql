-- RIO-116 — Migración 0017 (segundo bloque: comprobantes de liquidaciones
-- — conversión y transferencia — y notificaciones internas).
--
-- `comprobantes` gana columnas de rechazo: un documento de conversión o
-- transferencia puede ser rechazado por administración SIN alterar el
-- registro de negocio subyacente (`conversiones`/`transferencias_comision`
-- no cambian) — la fila rechazada sigue siendo la vigente hasta que se
-- suba un reemplazo (nueva versión), y conserva quién la rechazó, cuándo
-- y por qué. Simple ADD COLUMN — no hay cambio de CHECK, no hace falta
-- recrear la tabla.
ALTER TABLE comprobantes ADD COLUMN rechazado_por TEXT;
ALTER TABLE comprobantes ADD COLUMN rechazado_en TEXT;
ALTER TABLE comprobantes ADD COLUMN motivo_rechazo TEXT;

-- Notificaciones internas (Brenda: "crear una notificación interna para
-- Administración" al informar un pago o subir una nueva versión de su
-- comprobante — nunca el archivo adjunto, nunca una URL pública).
-- `clave_idempotencia` es la defensa contra duplicados por reintento: se
-- deriva del evento real que la origina (el id de `pagos_informados` o de
-- `comprobantes`, según el tipo) — dos intentos de notificar el MISMO
-- evento nunca crean una segunda fila (UNIQUE).
CREATE TABLE IF NOT EXISTS notificaciones (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('pago_informado', 'comprobante_nueva_version')),
  clave_idempotencia TEXT NOT NULL UNIQUE,
  venta_id TEXT REFERENCES ventas(id),
  pago_id TEXT,
  mercado TEXT,
  cliente_negocio TEXT,
  vendedor_email TEXT,
  -- Ruta relativa al portal, autenticada por Cloudflare Access como
  -- cualquier otra — nunca un token ni una URL absoluta firmada. Hoy es
  -- provisional (todavía no existe el panel administrativo real de
  -- RIO-119) — ver nota en notificaciones.js.
  ruta_portal TEXT NOT NULL,
  destinatario_rol TEXT NOT NULL DEFAULT 'admin' CHECK (destinatario_rol IN ('admin')),
  leida_en TEXT,
  leida_por TEXT,
  atendida_en TEXT,
  atendida_por TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notificaciones_pendientes ON notificaciones (destinatario_rol, atendida_en);
