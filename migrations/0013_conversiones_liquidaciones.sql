-- RIO-115 — Migración 0013
-- Ledger multimoneda (conversión real al pago, siempre vía Global66
-- operado a mano — nunca una API) y liquidaciones agrupadas (RIO-97 v2
-- secciones 16/17). Reutiliza por completo `comisiones` y su calendario
-- (`calcularFechaProgramada`, `dias_no_habiles`) de RIO-114 — no se
-- duplica nada de eso acá.
--
-- Regla aprobada sin excepción (sección 16): una venta en CL genera
-- comisión en CLP, una venta en AR en ARS — la comisión en ARS permanece
-- en ARS hasta el momento REAL del pago. La conversión ocurre una sola
-- vez, con el tipo de cambio que entregue Global66 en ese momento — nunca
-- recalculado por el sistema. Por eso `conversiones` solo modela
-- ARS -> CLP (es el único sentido que necesita el negocio: Brenda cobra
-- en Chile): un ejecutivo de Argentina cobra su comisión directamente en
-- ARS, sin pasar por acá.

CREATE TABLE IF NOT EXISTS conversiones (
  id TEXT PRIMARY KEY,
  comision_id TEXT NOT NULL UNIQUE REFERENCES comisiones(id), -- una comisión se convierte una sola vez.
  monto_original INTEGER NOT NULL CHECK (monto_original > 0),
  moneda_origen TEXT NOT NULL CHECK (moneda_origen = 'ARS'),
  fecha_conversion TEXT NOT NULL,
  medio TEXT NOT NULL DEFAULT 'Global66' CHECK (medio = 'Global66'), -- operado manualmente por Brenda — nunca una integración de API.
  tipo_cambio_mostrado REAL NOT NULL CHECK (tipo_cambio_mostrado > 0),
  costos_o_diferencias_informadas INTEGER NOT NULL DEFAULT 0,
  monto_convertido INTEGER NOT NULL CHECK (monto_convertido > 0),
  moneda_final TEXT NOT NULL CHECK (moneda_final = 'CLP'),
  registrado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Una transferencia agrupa N comisiones de una misma persona beneficiaria,
-- de una o ambas monedas, en un único monto final transferido (sección
-- 17). El comprobante de transferencia (banco) es un documento DISTINTO
-- del comprobante de conversión (Global66) — ninguno de los dos vive en
-- esta tabla todavía porque los archivos reales son RIO-116 (R2); acá solo
-- se registra el hecho auditable con una nota de texto, igual criterio que
-- `comprobante_nota` en pagos_informados desde RIO-113.
CREATE TABLE IF NOT EXISTS transferencias_comision (
  id TEXT PRIMARY KEY,
  beneficiario_email TEXT NOT NULL,
  fecha TEXT NOT NULL,
  moneda_final TEXT NOT NULL CHECK (moneda_final IN ('CLP', 'ARS')),
  monto_total_transferido INTEGER NOT NULL CHECK (monto_total_transferido > 0),
  comprobante_nota TEXT,
  registrado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transferencias_beneficiario ON transferencias_comision (beneficiario_email);

-- Detalle: qué comisión aportó cuánto a esa transferencia, y con qué
-- conversión si su moneda original no era la moneda final. Una comisión
-- solo puede aparecer en una transferencia (UNIQUE) — pagarla dos veces no
-- es posible por diseño, no solo por disciplina de código.
CREATE TABLE IF NOT EXISTS transferencia_detalle (
  id TEXT PRIMARY KEY,
  transferencia_id TEXT NOT NULL REFERENCES transferencias_comision(id),
  comision_id TEXT NOT NULL UNIQUE REFERENCES comisiones(id),
  monto_incluido INTEGER NOT NULL CHECK (monto_incluido > 0), -- siempre en la moneda_final de la transferencia.
  moneda_original TEXT NOT NULL CHECK (moneda_original IN ('CLP', 'ARS')),
  conversion_id TEXT REFERENCES conversiones(id), -- NULL cuando moneda_original = moneda_final de la transferencia (no hizo falta convertir).
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transferencia_detalle_transferencia ON transferencia_detalle (transferencia_id);

-- eventos_historial necesita 'liquidacion' y 'conversion' como entidades
-- válidas (RIO-97 v2 sección 18: "cada uno con usuario, fecha y hora").
-- Mismo patrón de recreación de tabla que 0008/0010 (SQLite no permite
-- alterar un CHECK existente). Sin riesgo de datos: no hay eventos reales
-- de producción todavía en Preview.
PRAGMA foreign_keys = OFF;

CREATE TABLE eventos_historial_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT, -- nullable a partir de acá: una liquidación/conversión puede agrupar comisiones de VARIAS ventas, no una sola.
  entidad TEXT NOT NULL CHECK (entidad IN ('venta', 'proyecto', 'componente', 'pago', 'incidencia', 'comision', 'conversion', 'liquidacion')),
  entidad_id TEXT NOT NULL,
  estado_anterior TEXT,
  estado_nuevo TEXT NOT NULL,
  usuario_email TEXT NOT NULL,
  motivo_nota TEXT,
  proxima_accion TEXT,
  responsable_proxima_accion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO eventos_historial_new (id, venta_id, entidad, entidad_id, estado_anterior, estado_nuevo, usuario_email, motivo_nota, proxima_accion, responsable_proxima_accion, created_at)
SELECT id, venta_id, entidad, entidad_id, estado_anterior, estado_nuevo, usuario_email, motivo_nota, proxima_accion, responsable_proxima_accion, created_at FROM eventos_historial;
DROP TABLE eventos_historial;
ALTER TABLE eventos_historial_new RENAME TO eventos_historial;
CREATE INDEX IF NOT EXISTS idx_eventos_historial_venta ON eventos_historial (venta_id);

PRAGMA foreign_keys = ON;
