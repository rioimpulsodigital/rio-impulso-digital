-- RIO-113 — Migración 0007
-- Pagos (informado ≠ acreditado), materiales por componente, historial
-- append-only, e incidencias — la máquina de estados en sí (transiciones)
-- vive en el código del Worker, no en constraints de la base; acá solo se
-- amplía el vocabulario de estados válidos y se agregan las tablas que
-- esa lógica necesita.
--
-- componentes.estado_actual tenía un CHECK que solo permitía
-- ('pendiente','bloqueada') desde RIO-112 — SQLite no permite modificar un
-- CHECK existente con ALTER TABLE, así que se recrea la tabla (patrón
-- documentado de SQLite: crear la nueva, copiar filas, borrar la vieja,
-- renombrar). Sin riesgo de datos: no hay componentes reales en preview
-- todavía (los únicos insertados durante RIO-112 fueron de prueba y se
-- borraron después de verificar).

PRAGMA foreign_keys = OFF;

CREATE TABLE componentes_new (
  id TEXT PRIMARY KEY,
  proyecto_id TEXT NOT NULL REFERENCES proyectos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ficha', 'landing')),
  precio_individual_referencia INTEGER NOT NULL,
  precio_atribuido INTEGER NOT NULL,
  -- Ciclo de vida de un componente (RIO-113):
  --   bloqueada     -> solo Landing de un pack, hasta que se cumplan las 3
  --                    condiciones (ver tryUnlockLanding en el código).
  --   pendiente     -> puede iniciar producción (materiales completos).
  --   en_produccion -> trabajo en curso.
  --   entregada     -> primera versión entregada al cliente. Para el
  --                    componente Ficha de un pack, este es el momento en
  --                    que corresponde pedir el segundo 50% (regla de
  --                    Brenda, RIO-97 v2 sección 7 reescrita) — no bloquea
  --                    nada por sí solo, es una señal de proceso.
  --   aprobada      -> aprobación definitiva del cliente. Terminal.
  -- Las correcciones NO son un estado aparte — se registran como eventos
  -- en eventos_historial mientras el componente permanece en 'entregada'.
  estado_actual TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_actual IN ('bloqueada', 'pendiente', 'en_produccion', 'entregada', 'aprobada')),
  materiales_estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (materiales_estado IN ('pendiente', 'completos')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO componentes_new (id, proyecto_id, tipo, precio_individual_referencia, precio_atribuido, estado_actual, created_at)
SELECT id, proyecto_id, tipo, precio_individual_referencia, precio_atribuido, estado_actual, created_at FROM componentes;

DROP TABLE componentes;
ALTER TABLE componentes_new RENAME TO componentes;
CREATE INDEX IF NOT EXISTS idx_componentes_proyecto ON componentes (proyecto_id);

PRAGMA foreign_keys = ON;

-- Pagos esperados por venta: 1 fila si individual (100%), 2 si pack
-- (inicial 50% + saldo 50%) — creadas al registrar la venta (RIO-112,
-- ventas/index.js extendido). "Informado ≠ acreditado" (RIO-97 v2): dos
-- tablas separadas, cada una con su propia fecha y responsable.
CREATE TABLE IF NOT EXISTS pagos_esperados (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('total', 'inicial', 'saldo')),
  monto INTEGER NOT NULL CHECK (monto > 0),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'informado', 'acreditado')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pagos_esperados_venta ON pagos_esperados (venta_id);

CREATE TABLE IF NOT EXISTS pagos_informados (
  id TEXT PRIMARY KEY,
  pago_esperado_id TEXT NOT NULL REFERENCES pagos_esperados(id),
  monto_informado INTEGER NOT NULL,
  informado_por TEXT NOT NULL,
  comprobante_nota TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS acreditaciones (
  id TEXT PRIMARY KEY,
  pago_informado_id TEXT NOT NULL REFERENCES pagos_informados(id),
  monto_acreditado INTEGER NOT NULL,
  verificado_por TEXT NOT NULL,
  nota TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial append-only — el Worker solo hace INSERT sobre esta tabla,
-- nunca UPDATE ni DELETE (disciplina de código, igual criterio que RIO-110
-- documentó para _system_health). Cancelaciones y disputas se registran
-- como una fila más, nunca borrando lo anterior.
CREATE TABLE IF NOT EXISTS eventos_historial (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  entidad TEXT NOT NULL CHECK (entidad IN ('venta', 'proyecto', 'componente', 'pago', 'incidencia')),
  entidad_id TEXT NOT NULL,
  estado_anterior TEXT,
  estado_nuevo TEXT NOT NULL,
  usuario_email TEXT NOT NULL,
  motivo_nota TEXT,
  proxima_accion TEXT,
  responsable_proxima_accion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eventos_historial_venta ON eventos_historial (venta_id);

-- Cancelaciones, devoluciones, reclamos y disputas — nunca elimina nada,
-- solo agrega una incidencia vinculada a la venta.
CREATE TABLE IF NOT EXISTS incidencias (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('cancelacion', 'devolucion', 'reclamo', 'disputa')),
  motivo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'resuelta')),
  registrado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resuelta_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidencias_venta ON incidencias (venta_id);
