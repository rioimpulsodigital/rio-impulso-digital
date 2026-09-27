-- RIO-115 (corrección) — Migración 0014
-- Brenda confirmó una nueva distribución de participaciones, exclusiva
-- para el componente Landing (nunca extendida a Ficha): 40% comercial +
-- 10% supervisión + 10% producción + 20% desarrollo + 20% empresa, todos
-- calculados sobre la MISMA base (precio atribuible a la Landing menos
-- sus costos directos) — nunca en cascada sobre el saldo de otra
-- comisión. Reemplaza, solo para el alcance de Landing:
--   - el supuesto anterior de que la comisión de producción (10%) podía
--     generarse igual para un componente Ficha (RIO-114 lo dejaba
--     genérico por tipo de componente; ahora queda confirmado que ese
--     10% — y el nuevo 20% de desarrollo — son EXCLUSIVOS de Landing).
--   - el plan comercial de Brenda (antes 0% parejo en los 5 productos):
--     ahora es 0% para Ficha y para el precio total de un pack, pero 40%
--     cuando ella vende una Landing individual (ver nota más abajo sobre
--     el caso de pack sin resolver).
--
-- 'empresa' (20%) NO se modela como una fila en `comisiones` — no es una
-- comisión personal ni utilidad final confirmada (Brenda: "todavía debe
-- cubrir los gastos generales y obligaciones correspondientes"). Se deja
-- como el remanente implícito no asignado, mismo criterio que ya existía
-- para "si no hay asistente asignado, ese % quedaba sin generar, como
-- utilidad de RiO" — no se inventa contabilidad integral acá (fuera de
-- alcance, explícito).
--
-- RIESGO ABIERTO, sin resolver en esta migración (Brenda: "no inventar
-- ahora"): en un PACK, el mecanismo actual de comisión comercial/
-- supervisión se calcula una sola vez sobre la utilidad neta de TODA la
-- venta (Ficha + Landing combinadas), a una única tasa. Cuando el mismo
-- vendedor tiene tasas DISTINTAS para Ficha (0%) y para Landing (40%) —
-- como ahora es el caso de Brenda — ese mecanismo de una sola tasa por
-- venta ya no puede calcular el monto correcto de un pack mixto. Por eso
-- el nuevo plan comercial de Brenda para Landing solo alcanza productos
-- de Landing INDIVIDUAL ('generico', 'personalizado') — un pack vendido
-- por Brenda sigue usando su plan de 0% hasta que se confirme cómo
-- repartir la tasa comercial entre Ficha y Landing dentro de un mismo
-- pack. Documentado también en RIO-115.
--
-- NOTA TÉCNICA sobre el orden de esta migración: D1 aplica las
-- restricciones de FOREIGN KEY en cada sentencia, sin importar
-- `PRAGMA foreign_keys` (a diferencia de SQLite estándar, donde ese
-- pragma sí permite desactivarlas temporalmente — confirmado con pruebas
-- directas contra D1 local antes de escribir esta versión). Por eso acá
-- no se usa el patrón "crear _new, borrar la vieja, renombrar" de
-- 0007/0008/0011 tal cual — se resguardan los datos reales de las tablas
-- con filas (planes_comision, asignaciones_plan_comision) en tablas de
-- respaldo temporales, se borra TODA la cadena de dependencia de hojas
-- hacia la raíz (transferencia_detalle -> conversiones -> comisiones ->
-- asignaciones_plan_comision -> planes_comision — todas vacías en
-- Preview excepto las dos primeras), y se reconstruye de raíz hacia
-- hojas. `comisiones`, `conversiones` y `transferencia_detalle` están
-- vacías en Preview (confirmado antes de escribir esta migración) — no
-- necesitan respaldo.

CREATE TABLE _bak_planes_comision AS SELECT * FROM planes_comision;
CREATE TABLE _bak_asignaciones_plan_comision AS SELECT * FROM asignaciones_plan_comision;

DROP TABLE IF EXISTS transferencia_detalle;
DROP TABLE IF EXISTS conversiones;
DROP TABLE comisiones;
DROP TABLE asignaciones_plan_comision;
DROP TABLE planes_comision;

-- Raíz: planes_comision, con 'desarrollo' agregado al CHECK de tipo.
CREATE TABLE planes_comision (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion', 'desarrollo')),
  porcentaje INTEGER NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),
  base TEXT NOT NULL CHECK (base IN ('utilidad_neta_venta', 'utilidad_neta_componente')),
  productos_alcanzados TEXT NOT NULL,
  mercados_alcanzados TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO planes_comision SELECT * FROM _bak_planes_comision;
DROP TABLE _bak_planes_comision;
CREATE INDEX IF NOT EXISTS idx_planes_comision_tipo ON planes_comision (tipo, estado, valid_until);

-- Asignaciones de plan — mismo esquema que 0011, solo se recrea para
-- volver a apuntar su FK a la nueva `planes_comision`.
CREATE TABLE asignaciones_plan_comision (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  plan_id TEXT NOT NULL REFERENCES planes_comision(id),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO asignaciones_plan_comision SELECT * FROM _bak_asignaciones_plan_comision;
DROP TABLE _bak_asignaciones_plan_comision;
CREATE INDEX IF NOT EXISTS idx_asignaciones_plan_comision_usuario ON asignaciones_plan_comision (usuario_id, valid_until);

-- comisiones — mismo esquema que 0011, con 'desarrollo' agregado al
-- CHECK de tipo. Vacía en Preview, no hace falta restaurar datos.
CREATE TABLE comisiones (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion', 'desarrollo')),
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
CREATE INDEX IF NOT EXISTS idx_comisiones_venta ON comisiones (venta_id);
CREATE INDEX IF NOT EXISTS idx_comisiones_beneficiario ON comisiones (beneficiario_email);

-- conversiones y transferencia_detalle — mismo esquema que 0013, ambas
-- vacías en Preview, solo se vuelven a crear para apuntar a la nueva
-- `comisiones`.
CREATE TABLE conversiones (
  id TEXT PRIMARY KEY,
  comision_id TEXT NOT NULL UNIQUE REFERENCES comisiones(id),
  monto_original INTEGER NOT NULL CHECK (monto_original > 0),
  moneda_origen TEXT NOT NULL CHECK (moneda_origen = 'ARS'),
  fecha_conversion TEXT NOT NULL,
  medio TEXT NOT NULL DEFAULT 'Global66' CHECK (medio = 'Global66'),
  tipo_cambio_mostrado REAL NOT NULL CHECK (tipo_cambio_mostrado > 0),
  costos_o_diferencias_informadas INTEGER NOT NULL DEFAULT 0,
  monto_convertido INTEGER NOT NULL CHECK (monto_convertido > 0),
  moneda_final TEXT NOT NULL CHECK (moneda_final = 'CLP'),
  registrado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transferencia_detalle (
  id TEXT PRIMARY KEY,
  transferencia_id TEXT NOT NULL REFERENCES transferencias_comision(id),
  comision_id TEXT NOT NULL UNIQUE REFERENCES comisiones(id),
  monto_incluido INTEGER NOT NULL CHECK (monto_incluido > 0),
  moneda_original TEXT NOT NULL CHECK (moneda_original IN ('CLP', 'ARS')),
  conversion_id TEXT REFERENCES conversiones(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transferencia_detalle_transferencia ON transferencia_detalle (transferencia_id);

-- asignaciones_produccion gana un `rol` (produccion | desarrollo): un
-- componente puede tener HASTA una persona asignada por rol — pueden ser
-- la misma persona en ambos roles, o dos personas distintas (ejemplo de
-- Brenda: el practicante produce, ella desarrolla). Tabla vacía en
-- Preview, nada que respaldar. Nada más referencia esta tabla, así que
-- se puede recrear de forma independiente del resto de esta migración.
DROP TABLE IF EXISTS asignaciones_produccion;
CREATE TABLE asignaciones_produccion (
  id TEXT PRIMARY KEY,
  usuario_email TEXT NOT NULL,
  componente_id TEXT NOT NULL REFERENCES componentes(id),
  rol TEXT NOT NULL CHECK (rol IN ('produccion', 'desarrollo')),
  asignado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (componente_id, rol)
);

-- Nuevos planes confirmados por Brenda (30/08/2026) — vigentes desde
-- ahora, activados de inmediato porque ella ya los confirmó como
-- definitivos (a diferencia de las asignaciones de producción/desarrollo
-- a un componente real, que quedan sin sembrar: no hay ningún proyecto
-- Landing concreto todavía al que asignarle a nadie — RIO-97: "sin
-- retroactividad").
INSERT INTO planes_comision (id, tipo, porcentaje, base, productos_alcanzados, mercados_alcanzados, created_by, note) VALUES
  ('plan-desarrollo-20-landing', 'desarrollo', 20, 'utilidad_neta_componente', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-115-seed', 'Confirmado por Brenda 30/08/2026 — 20% sobre la utilidad neta del componente Landing trabajado. El código solo lo genera para componentes tipo=landing, nunca Ficha, sin importar esta lista de productos (que describe la venta, no el componente).'),
  ('plan-comercial-40-landing', 'comercial', 40, 'utilidad_neta_venta', '["generico","personalizado"]', '["CL","AR"]', 'rio-115-seed', 'Confirmado por Brenda 30/08/2026 — 40% comercial cuando la venta es una Landing individual (Express o Premium). NO incluye los códigos de pack (ficha_generico/ficha_personalizado) — ver nota de riesgo abierto en la migración sobre tasas mixtas dentro de un mismo pack.'),
  ('plan-comercial-0-sin-landing', 'comercial', 0, 'utilidad_neta_venta', '["ficha","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-115-seed', 'Confirmado por Brenda 30/08/2026 — reemplaza, solo para Brenda, el alcance de su plan comercial 0% original: cubre Ficha individual y ambos packs (pendiente de definir cómo repartir Ficha/Landing dentro del pack), pero YA NO cubre Landing individual (eso ahora es plan-comercial-40-landing).');

-- Cierra la asignación anterior de Brenda al plan comercial 0% general
-- (RIO-114, migración 0012) — nunca se edita, se cierra y se reemplaza
-- por las dos asignaciones nuevas y más específicas.
UPDATE asignaciones_plan_comision
SET valid_until = datetime('now')
WHERE plan_id = 'plan-comercial-0'
  AND usuario_id = (SELECT id FROM usuarios WHERE email = 'brenda@rioimpulsodigital.com')
  AND valid_until IS NULL;

INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-comercial-0-sin-landing', 'rio-115-seed', 'Semilla — reemplaza el plan comercial 0% general de Brenda, ahora acotado a Ficha y packs'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';

INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-comercial-40-landing', 'rio-115-seed', 'Semilla — Brenda vendiendo una Landing individual, confirmado 30/08/2026'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';

INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-produccion-10', 'rio-115-seed', 'Semilla — Brenda puede producir personalmente una Landing, confirmado 30/08/2026'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';

INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-desarrollo-20-landing', 'rio-115-seed', 'Semilla — Brenda desarrollando una Landing, confirmado 30/08/2026'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';
