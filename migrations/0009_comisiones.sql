-- RIO-114 — Migración 0009
-- Comisiones: tabla de tasas editable (no un porcentaje fijo en el código —
-- Brenda, 28/08/2026: "debe ser un valor que yo pueda editar en una tabla de
-- acuerdo al proyecto vendido"), costos directos por componente, y la
-- máquina de 9 estados de la comisión (RIO-97 v2 sección 8), independiente
-- de la máquina de estados del proyecto (RIO-113).

-- Tasas de comisión por tipo de comisión y producto — versionada igual que
-- asignaciones_rol (nunca se edita una fila cerrada; un cambio de tasa
-- cierra la vigente e inserta una nueva, así una comisión ya calculada
-- conserva el porcentaje con el que se generó, aunque la tasa general
-- cambie después — RIO-97 v2 sección 4, "commissionPlan es una entidad
-- separada del usuario").
--
-- Solo se siembra lo que Brenda confirmó (comercial 40% en los 5 productos
-- que existen hoy: ficha, generico, personalizado y sus dos combinaciones en
-- pack). Supervisión y producción quedan SIN sembrar a propósito — sin tasa
-- cargada, el sistema nunca inventa un número (ver comisiones.sql más abajo:
-- una comisión sin plan vigente queda con porcentaje_snapshot NULL, nunca 0
-- disfrazado de "sin comisión", hasta que se cargue la tasa real).
CREATE TABLE IF NOT EXISTS planes_comision (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion')),
  producto TEXT NOT NULL CHECK (producto IN ('ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado')),
  porcentaje INTEGER NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),
  base TEXT NOT NULL CHECK (base IN ('utilidad_neta_venta', 'utilidad_neta_componente')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_planes_comision_vigencia ON planes_comision (tipo, producto, valid_until);

INSERT INTO planes_comision (id, tipo, producto, porcentaje, base, created_by, note)
SELECT lower(hex(randomblob(16))), 'comercial', producto, 40, 'utilidad_neta_venta', 'rio-114-seed', 'Confirmado por Brenda 28/08/2026 — comercial 40% para landing/ficha/pack (los 5 productos vigentes hoy)'
FROM (SELECT 'ficha' AS producto UNION ALL SELECT 'generico' UNION ALL SELECT 'personalizado' UNION ALL SELECT 'ficha_generico' UNION ALL SELECT 'ficha_personalizado');

-- Costo directo asociado a un componente específico (ej. dominio propio de
-- una Landing Premium) — nunca a la venta completa (RIO-97 v2 sección 6:
-- "el costo pertenece al componente que lo genera"). Se descuenta de la
-- utilidad neta de ese componente antes de calcular cualquier comisión
-- sobre él. Alta exclusiva de administración (autorizado_por).
CREATE TABLE IF NOT EXISTS costos_directos (
  id TEXT PRIMARY KEY,
  componente_id TEXT NOT NULL REFERENCES componentes(id),
  tipo TEXT NOT NULL,
  monto INTEGER NOT NULL CHECK (monto > 0),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  autorizado_por TEXT NOT NULL,
  nota TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_costos_directos_componente ON costos_directos (componente_id);

-- Comisión — una fila por (venta, tipo) para comercial/supervisión, o por
-- (componente, tipo) para producción (RIO-97 v2 sección 6: "hasta 2 de
-- producción, una por componente, si hay asistente asignado"). Cada fila es
-- su PROPIA instancia de la máquina de 9 estados — que la comercial esté
-- pagada no implica nada sobre la de supervisión del mismo proyecto.
--
-- Estados 2/3/4/5 no son secuenciales entre sí (mismo patrón que el gate de
-- Landing en RIO-113): se registran como condiciones/fechas independientes
-- y una función de gate las evalúa juntas para decidir si ya corresponde
-- 'habilitada'. 'programada' se calcula automáticamente al habilitarse
-- (calendario 26→10/11→25, sección 10) — nunca requiere una acción manual
-- aparte. 'pagada' sí es siempre una acción explícita de administración.
CREATE TABLE IF NOT EXISTS comisiones (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion')),
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  componente_id TEXT REFERENCES componentes(id), -- solo producción; NULL en comercial/supervisión.
  beneficiario_email TEXT NOT NULL,
  plan_id TEXT REFERENCES planes_comision(id), -- NULL si no había tasa vigente al generarse.
  porcentaje_snapshot INTEGER, -- NULL = sin tasa configurada todavía, nunca 0 disfrazado.
  base_snapshot TEXT CHECK (base_snapshot IS NULL OR base_snapshot IN ('utilidad_neta_venta', 'utilidad_neta_componente')),
  monto_base INTEGER, -- utilidad neta (precio_atribuido - costos_directos) al momento de generarse.
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  monto_comision INTEGER, -- NULL mientras porcentaje_snapshot sea NULL.
  estado TEXT NOT NULL DEFAULT 'calculada_provisional' CHECK (estado IN (
    'calculada_provisional', 'habilitada', 'programada', 'pagada'
  )),
  -- Condiciones independientes que alimentan el paso a 'habilitada' — cada
  -- una con su propia fecha, nunca una sola "fecha de comisión" (RIO-97 v2
  -- sección 8).
  fecha_inicio_plazo TEXT, -- acreditación del primer pago (total si individual, inicial si pack).
  fecha_cumplimiento_plazo TEXT, -- fecha_inicio_plazo + duración configurada (sección 9), calculada al evaluar el gate.
  fecha_pago_total_acreditado TEXT, -- cuando TODOS los pagos_esperados de la venta quedaron acreditados.
  fecha_habilitacion TEXT,
  fecha_programada_original TEXT,
  fecha_programada_efectiva TEXT,
  fecha_pago_real TEXT,
  motivo_retencion_o_reprogramacion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comisiones_venta ON comisiones (venta_id);
CREATE INDEX IF NOT EXISTS idx_comisiones_beneficiario ON comisiones (beneficiario_email);
