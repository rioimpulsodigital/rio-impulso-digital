-- RIO-115 (consolidación) — Migración 0015
-- Brenda confirmó el modelo definitivo de participaciones y equipos
-- (31/08/2026), que REEMPLAZA las distribuciones anteriores de RIO-114/
-- RIO-115, incluido el plan comercial 0%/40%-solo-Landing de Brenda.
--
-- 1) DISTRIBUCIONES CONFIRMADAS
--    Landing, Ficha y Pack (por componente): 40 comercial + 10 supervisión
--    + 30 realización + 20 empresa = 100%. Todos sobre la misma base
--    (utilidad neta del componente/venta) — nunca en cascada.
--    Páginas web (producto futuro, NO operativo todavía — solo se registra
--    el plan configurable, sin ampliar el flujo): 25 comercial + 10
--    supervisión + 45 desarrollo + 20 empresa = 100%.
--
-- 2) REALIZACIÓN reemplaza a producción(10%)+desarrollo(20%) como roles
--    siempre independientes. Ahora es UN solo pool de 30%:
--    - Sin practicante: el responsable se lleva el 30% entero.
--    - Con practicante: responsable 20% + practicante 10% (el practicante
--      participa DENTRO del 30%, nunca por encima).
--    `planes_comision.contexto_realizacion` distingue qué plan corresponde
--    en cada caso ('solo' | 'responsable_con_practicante' | 'practicante').
--    `asignaciones_produccion` se renombra a `asignaciones_realizacion`,
--    con `rol` ahora ('responsable' | 'practicante') en vez de
--    ('produccion' | 'desarrollo').
--
-- 3) EQUIPOS — "mercado no equivale a equipo". Nuevas tablas `equipos`,
--    `equipo_supervisores` (versionada) y `equipo_miembros` (versionada).
--    `ventas.equipo_id` es un SNAPSHOT inmutable del equipo del vendedor
--    al momento de la venta (mismo criterio que el resto del sistema:
--    nunca se recalcula con datos de después). La comisión de supervisión
--    ahora se genera para el supervisor de ESE equipo, no para "todos los
--    supervisores del mercado".
--
-- NOTA TÉCNICA: D1 exige FOREIGN KEY en cada sentencia sin importar
-- `PRAGMA foreign_keys` (confirmado en la migración 0014). Por eso la
-- cadena planes_comision -> asignaciones_plan_comision / comisiones ->
-- conversiones / transferencia_detalle se recrea de hojas a raíz,
-- resguardando en tablas temporales los datos reales de planes_comision y
-- asignaciones_plan_comision (las demás están vacías en Preview,
-- confirmado antes de escribir esta migración). `asignaciones_produccion`
-- no tiene FK entrante de nadie — se recrea directo. `ventas` no cambia de
-- CHECK, solo gana una columna — ALTER TABLE ADD COLUMN simple, sin
-- necesidad de recrear la tabla.

CREATE TABLE _bak_planes_comision AS SELECT * FROM planes_comision;
CREATE TABLE _bak_asignaciones_plan_comision AS SELECT * FROM asignaciones_plan_comision;

DROP TABLE IF EXISTS transferencia_detalle;
DROP TABLE IF EXISTS conversiones;
DROP TABLE comisiones;
DROP TABLE asignaciones_plan_comision;
DROP TABLE planes_comision;
DROP TABLE asignaciones_produccion;

-- ── Raíz: planes_comision ───────────────────────────────────────────
CREATE TABLE planes_comision (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion', 'realizacion', 'desarrollo')),
  -- Solo tiene sentido cuando tipo = 'realizacion': distingue cuál de los
  -- 3 escenarios de reparto del pool de 30% corresponde este plan.
  contexto_realizacion TEXT CHECK (contexto_realizacion IS NULL OR contexto_realizacion IN ('solo', 'responsable_con_practicante', 'practicante')),
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
INSERT INTO planes_comision (id, tipo, porcentaje, base, productos_alcanzados, mercados_alcanzados, estado, valid_from, valid_until, note, created_by, created_at)
SELECT id, tipo, porcentaje, base, productos_alcanzados, mercados_alcanzados, estado, valid_from, valid_until, note, created_by, created_at FROM _bak_planes_comision;
DROP TABLE _bak_planes_comision;
CREATE INDEX IF NOT EXISTS idx_planes_comision_tipo ON planes_comision (tipo, estado, valid_until);

-- ── asignaciones_plan_comision (sin cambios de esquema, solo se vuelve a
--    apuntar a la nueva planes_comision) ─────────────────────────────
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

-- ── comisiones ───────────────────────────────────────────────────────
CREATE TABLE comisiones (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('comercial', 'supervision', 'produccion', 'realizacion', 'desarrollo')),
  -- Solo tiene sentido cuando tipo = 'realizacion': deja trazabilidad de
  -- si esta fila es la del responsable o la del practicante.
  rol_realizacion TEXT CHECK (rol_realizacion IS NULL OR rol_realizacion IN ('responsable', 'practicante')),
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

-- ── conversiones y transferencia_detalle (mismo esquema que 0013, solo
--    se recrean para apuntar a la nueva comisiones) ────────────────────
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

-- ── asignaciones_realizacion (reemplaza a asignaciones_produccion) ────
-- Asigna a una persona un componente para un rol de realización
-- ('responsable' | 'practicante'). Un componente admite hasta una persona
-- por rol (UNIQUE) — la misma persona puede ser responsable Y practicante
-- de otro componente distinto, pero no ambos roles del mismo componente a
-- la vez (no tendría sentido: el practicante participa DENTRO del 30% del
-- responsable).
CREATE TABLE asignaciones_realizacion (
  id TEXT PRIMARY KEY,
  usuario_email TEXT NOT NULL,
  componente_id TEXT NOT NULL REFERENCES componentes(id),
  rol TEXT NOT NULL CHECK (rol IN ('responsable', 'practicante')),
  asignado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (componente_id, rol)
);

-- ── Equipos — "mercado no equivale a equipo" ───────────────────────────
CREATE TABLE equipos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  mercado TEXT NOT NULL CHECK (mercado IN ('CL', 'AR')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Supervisor de un equipo — versionado (nunca se edita una fila cerrada,
-- un cambio de supervisor cierra la vigente e inserta una nueva). La
-- disciplina de "a lo sumo un supervisor vigente por equipo" se aplica en
-- código, mismo criterio que asignaciones_rol.
CREATE TABLE equipo_supervisores (
  id TEXT PRIMARY KEY,
  equipo_id TEXT NOT NULL REFERENCES equipos(id),
  usuario_email TEXT NOT NULL,
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_equipo_supervisores_equipo ON equipo_supervisores (equipo_id, valid_until);

-- Miembros (vendedores) de un equipo — versionado, una persona puede
-- cambiar de equipo con el tiempo sin alterar el historial de ventas ya
-- atribuidas (esas quedan con su propio snapshot en ventas.equipo_id).
CREATE TABLE equipo_miembros (
  id TEXT PRIMARY KEY,
  equipo_id TEXT NOT NULL REFERENCES equipos(id),
  usuario_email TEXT NOT NULL,
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_equipo_miembros_equipo ON equipo_miembros (equipo_id, valid_until);
CREATE INDEX IF NOT EXISTS idx_equipo_miembros_usuario ON equipo_miembros (usuario_email, valid_until);

-- ventas gana el snapshot inmutable de a qué equipo pertenecía el
-- vendedor al momento de la venta — nunca se recalcula después. Sin esto,
-- la comisión de supervisión no tiene a quién generarse (no se inventa un
-- supervisor "por mercado" — ver comisiones.js).
ALTER TABLE ventas ADD COLUMN equipo_id TEXT REFERENCES equipos(id);

-- ═══════════════════════════════════════════════════════════════════
-- SIEMBRA — decisiones confirmadas por Brenda (31/08/2026)
-- ═══════════════════════════════════════════════════════════════════

-- 1) Cierra TODOS los planes/asignaciones que el nuevo modelo reemplaza
--    (nunca se editan, se cierran con valid_until y quedan como historial).
UPDATE planes_comision SET valid_until = datetime('now'), estado = 'inactivo'
WHERE id IN ('plan-produccion-10', 'plan-desarrollo-20-landing', 'plan-comercial-40-landing', 'plan-comercial-0-sin-landing')
  AND valid_until IS NULL;

UPDATE asignaciones_plan_comision SET valid_until = datetime('now')
WHERE plan_id IN ('plan-produccion-10', 'plan-desarrollo-20-landing', 'plan-comercial-40-landing', 'plan-comercial-0-sin-landing', 'plan-comercial-0')
  AND valid_until IS NULL;

-- 2) Nuevos planes — Landing/Ficha/Pack (comercial 40 y supervisión 10 ya
--    existían y siguen vigentes sin cambios; solo se agrega realización).
INSERT INTO planes_comision (id, tipo, contexto_realizacion, porcentaje, base, productos_alcanzados, mercados_alcanzados, created_by, note) VALUES
  ('plan-realizacion-solo-30', 'realizacion', 'solo', 30, 'utilidad_neta_componente', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-115-seed', 'Confirmado por Brenda 31/08/2026 — sin practicante, el responsable se lleva el 30% entero de la utilidad neta del componente.'),
  ('plan-realizacion-responsable-20', 'realizacion', 'responsable_con_practicante', 20, 'utilidad_neta_componente', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-115-seed', 'Confirmado por Brenda 31/08/2026 — con practicante asignado, el responsable se lleva 20% (el practicante participa dentro del 30%, nunca por encima).'),
  ('plan-realizacion-practicante-10', 'realizacion', 'practicante', 10, 'utilidad_neta_componente', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-115-seed', 'Confirmado por Brenda 31/08/2026 — el practicante se lleva 10% cuando hay un responsable con practicante asignado.');

-- 3) Páginas web — producto FUTURO, no operativo (ninguna venta puede
--    usar 'pagina_web' hoy, el CHECK de ventas.producto no lo admite).
--    Se registra el plan configurable, sin ampliar el flujo operativo:
--    no se reparte el 45% entre responsable/practicante todavía.
INSERT INTO planes_comision (id, tipo, porcentaje, base, productos_alcanzados, mercados_alcanzados, estado, created_by, note) VALUES
  ('plan-comercial-25-pagina-web', 'comercial', 25, 'utilidad_neta_venta', '["pagina_web"]', '["CL","AR"]', 'activo', 'rio-115-seed', 'Confirmado por Brenda 31/08/2026 — plan registrado para el futuro producto Páginas web. Inerte hoy: ningún venta.producto puede ser "pagina_web" todavía.'),
  ('plan-supervision-10-pagina-web', 'supervision', 10, 'utilidad_neta_venta', '["pagina_web"]', '["CL","AR"]', 'activo', 'rio-115-seed', 'Confirmado por Brenda 31/08/2026 — plan registrado para el futuro producto Páginas web. Inerte hoy.'),
  ('plan-desarrollo-45-pagina-web', 'desarrollo', 45, 'utilidad_neta_componente', '["pagina_web"]', '["CL","AR"]', 'activo', 'rio-115-seed', 'Confirmado por Brenda 31/08/2026 — plan registrado para el futuro producto Páginas web. Sin reparto responsable/practicante todavía (no inventar ahora). Inerte hoy.');

-- 4) Reasignación de Brenda: ya no 0%/40%-solo-Landing — ahora comercial
--    uniforme 40% como cualquiera (una venta de Pack que ella haga genera
--    su participación comercial vigente, no el antiguo 0%). También puede
--    tener plan de realización, PERO nunca se le asigna un componente
--    automáticamente por ser administradora — eso requiere una asignación
--    expresa aparte (asignaciones_realizacion), que queda sin sembrar.
INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-comercial-40', 'rio-115-seed', 'Semilla — Brenda pasa a comercial 40% uniforme, reemplaza su 0%/40%-Landing anterior, confirmado 31/08/2026'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';

INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-realizacion-solo-30', 'rio-115-seed', 'Semilla — Brenda puede realizar personalmente un componente sin practicante, confirmado 31/08/2026'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';

INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-realizacion-responsable-20', 'rio-115-seed', 'Semilla — Brenda como responsable cuando hay un practicante asignado, confirmado 31/08/2026'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';

-- 5) Equipos — Alberto supervisa hoy en ambos mercados (CL y AR), así que
--    se crean dos equipos, uno por mercado, con los ejecutivos reales de
--    cada uno como miembros. "Mercado no equivale a equipo" igual: el día
--    que haya un segundo supervisor en el mismo mercado, se crea un
--    equipo nuevo con sus propios miembros, sin tocar el de Alberto.
INSERT INTO equipos (id, nombre, mercado, created_by) VALUES
  ('equipo-alberto-cl', 'Equipo Alberto — Chile', 'CL', 'rio-115-seed'),
  ('equipo-alberto-ar', 'Equipo Alberto — Argentina', 'AR', 'rio-115-seed');

INSERT INTO equipo_supervisores (id, equipo_id, usuario_email, created_by)
VALUES
  (lower(hex(randomblob(16))), 'equipo-alberto-cl', 'albertoperezmatta@gmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-ar', 'albertoperezmatta@gmail.com', 'rio-115-seed');

INSERT INTO equipo_miembros (id, equipo_id, usuario_email, created_by) VALUES
  (lower(hex(randomblob(16))), 'equipo-alberto-cl', 'gabrielaaleroa@gmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-cl', 'jotaherre024@gmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-cl', 'lorenaramirezfuentealba@gmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-cl', 'fjamis@gmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-cl', 'mchristian.reyes@gmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-ar', 'araujochristianwalterdejesus@gmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-ar', 'lore_1212@hotmail.com', 'rio-115-seed'),
  (lower(hex(randomblob(16))), 'equipo-alberto-ar', 'mholsbachperalta@gmail.com', 'rio-115-seed');
