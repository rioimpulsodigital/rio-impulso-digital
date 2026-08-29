-- RIO-114 (corrección) — Migración 0011
-- Decisiones definitivas de Brenda (28/08/2026, segunda corrección) sobre
-- comisiones: separa la DEFINICIÓN de un plan (tipo, porcentaje, base,
-- productos y mercados alcanzados, estado) de la ASIGNACIÓN de ese plan a
-- una persona (versionada como cualquier otra asignación del sistema,
-- nunca se edita una fila cerrada). La tabla plana anterior
-- (planes_comision por tipo+producto, migración 0009) no permitía esto —
-- se recrea con el modelo correcto.

PRAGMA foreign_keys = OFF;

-- Definición de un plan — reutilizable por varias personas a la vez (ej.
-- "comercial 40%" lo tienen todos los ejecutivos actuales).
CREATE TABLE planes_comision_new (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion')),
  porcentaje INTEGER NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),
  base TEXT NOT NULL CHECK (base IN ('utilidad_neta_venta', 'utilidad_neta_componente')),
  -- JSON de productos/mercados alcanzados — ej. '["ficha","generico"]',
  -- '["CL","AR"]'. Nunca se resuelve por nombre propio de persona, solo por
  -- estos datos.
  productos_alcanzados TEXT NOT NULL,
  mercados_alcanzados TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
DROP TABLE planes_comision;
ALTER TABLE planes_comision_new RENAME TO planes_comision;
CREATE INDEX IF NOT EXISTS idx_planes_comision_tipo ON planes_comision (tipo, estado, valid_until);

-- Asignación de un plan a una persona — mismo patrón de vigencia que
-- asignaciones_rol (RIO-111): nunca se edita una fila cerrada, un cambio
-- de plan cierra la vigente e inserta una nueva. Una persona puede tener
-- asignaciones vigentes de más de un tipo a la vez (ej. comercial +
-- producción), pero como máximo una vigente POR TIPO.
CREATE TABLE IF NOT EXISTS asignaciones_plan_comision (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  plan_id TEXT NOT NULL REFERENCES planes_comision(id),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asignaciones_plan_comision_usuario ON asignaciones_plan_comision (usuario_id, valid_until);

-- Asignación de un asistente/practicante a un componente específico — el
-- prerrequisito real de la comisión de producción (RIO-97 v2: "hoy sin
-- nadie asignado"). No pertenece formalmente a ninguna otra tarea del plan
-- maestro (RIO-107 no tiene una tarea de "asignación de producción"), así
-- que se crea acá — es lo mínimo que necesita el cálculo de comisiones
-- para saber si corresponde generar una. No es un sistema de permisos ni
-- de flujo de producción — eso, si llega a existir, es una tarea futura
-- aparte. Un componente admite un único asistente asignado en esta etapa
-- (RIO-97 v2: "no se diseña reparto entre varios asistentes ahora").
CREATE TABLE IF NOT EXISTS asignaciones_produccion (
  id TEXT PRIMARY KEY,
  usuario_email TEXT NOT NULL,
  componente_id TEXT NOT NULL UNIQUE REFERENCES componentes(id),
  asignado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Calendario de días no hábiles por mercado — administrable y auditable,
-- en vez de feriados fijos en el código (Brenda: "no hardcodear feriados
-- indefinidamente"). El ajuste de fin de semana sigue siendo automático
-- (sábado/domingo), esta tabla cubre feriados puntuales de cada mercado.
CREATE TABLE IF NOT EXISTS dias_no_habiles (
  id TEXT PRIMARY KEY,
  mercado TEXT NOT NULL CHECK (mercado IN ('CL', 'AR')),
  fecha TEXT NOT NULL, -- 'YYYY-MM-DD'
  motivo TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mercado, fecha)
);

-- comisiones: agrega asignacion_plan_id (traza exacta de qué asignación se
-- usó, no solo qué plan) y el estado 'retenida' (una comisión ya
-- habilitada/programada puede retenerse si aparece una disputa antes del
-- pago — nunca desaparece, queda con su historial — Brenda, sección 6 de
-- esta corrección).
CREATE TABLE comisiones_new (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion')),
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  componente_id TEXT REFERENCES componentes(id),
  beneficiario_email TEXT NOT NULL,
  plan_id TEXT REFERENCES planes_comision(id),
  asignacion_plan_id TEXT REFERENCES asignaciones_plan_comision(id),
  porcentaje_snapshot INTEGER,
  base_snapshot TEXT CHECK (base_snapshot IS NULL OR base_snapshot IN ('utilidad_neta_venta', 'utilidad_neta_componente')),
  monto_base INTEGER,
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  monto_comision INTEGER,
  estado TEXT NOT NULL DEFAULT 'calculada_provisional' CHECK (estado IN (
    'calculada_provisional', 'retenida', 'habilitada', 'programada', 'pagada'
  )),
  fecha_inicio_plazo TEXT,
  fecha_cumplimiento_plazo TEXT,
  fecha_pago_total_acreditado TEXT,
  fecha_habilitacion TEXT,
  fecha_programada_original TEXT,
  fecha_programada_efectiva TEXT,
  fecha_pago_real TEXT,
  motivo_retencion_o_reprogramacion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO comisiones_new (id, tipo, venta_id, componente_id, beneficiario_email, plan_id, porcentaje_snapshot, base_snapshot, monto_base, moneda, monto_comision, estado, fecha_inicio_plazo, fecha_cumplimiento_plazo, fecha_pago_total_acreditado, fecha_habilitacion, fecha_programada_original, fecha_programada_efectiva, fecha_pago_real, motivo_retencion_o_reprogramacion, created_at)
SELECT id, tipo, venta_id, componente_id, beneficiario_email, plan_id, porcentaje_snapshot, base_snapshot, monto_base, moneda, monto_comision, estado, fecha_inicio_plazo, fecha_cumplimiento_plazo, fecha_pago_total_acreditado, fecha_habilitacion, fecha_programada_original, fecha_programada_efectiva, fecha_pago_real, motivo_retencion_o_reprogramacion, created_at FROM comisiones;
DROP TABLE comisiones;
ALTER TABLE comisiones_new RENAME TO comisiones;
CREATE INDEX IF NOT EXISTS idx_comisiones_venta ON comisiones (venta_id);
CREATE INDEX IF NOT EXISTS idx_comisiones_beneficiario ON comisiones (beneficiario_email);

PRAGMA foreign_keys = ON;

-- Siembra: los 3 planes confirmados por Brenda. Comercial 40% y
-- supervisión 10% ya vigentes en los 5 productos actuales y ambos
-- mercados. Producción 10% sobre la utilidad neta del COMPONENTE (no de
-- la venta) — confirmado como valor inicial en la sección 8, aunque hoy
-- no haya ningún asistente para asignarle un componente todavía.
INSERT INTO planes_comision (id, tipo, porcentaje, base, productos_alcanzados, mercados_alcanzados, created_by, note) VALUES
  ('plan-comercial-40', 'comercial', 40, 'utilidad_neta_venta', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-114-seed', 'Confirmado por Brenda 28/08/2026 — comercial 40% en Ficha, Landing y Pack'),
  ('plan-supervision-10', 'supervision', 10, 'utilidad_neta_venta', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-114-seed', 'Confirmado por Brenda 28/08/2026 — supervisión 10% sobre la utilidad neta de la venta'),
  ('plan-produccion-10', 'produccion', 10, 'utilidad_neta_componente', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-114-seed', 'Confirmado por Brenda 28/08/2026 — producción 10% sobre la utilidad neta del componente trabajado');

-- Asigna el plan comercial a todo el plantel que hoy vende (ejecutivos) —
-- nunca a admin (RIO-97 v2 sección 4: "el admin no tiene comisión" — la
-- comisión de las ventas de Brenda específicamente sigue pendiente de
-- confirmación económica, no se asume acá) ni al supervisor (la posible
-- acumulación de comercial + supervisión cuando el supervisor vende
-- personalmente también queda pendiente — sin plan comercial asignado,
-- esas ventas hoy generan 0 comisión comercial, nunca un número inventado).
INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-comercial-40', 'rio-114-seed', 'Semilla — plantel de ejecutivos vigente 28/08/2026'
FROM usuarios u JOIN asignaciones_rol a ON a.usuario_id = u.id
WHERE a.role = 'ejecutivo' AND a.valid_until IS NULL AND a.user_status = 'activo';

-- Asigna el plan de supervisión a Alberto (único supervisor activo hoy).
INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-supervision-10', 'rio-114-seed', 'Semilla — supervisor vigente 28/08/2026'
FROM usuarios u JOIN asignaciones_rol a ON a.usuario_id = u.id
WHERE a.role = 'supervisor' AND a.valid_until IS NULL AND a.user_status = 'activo';
