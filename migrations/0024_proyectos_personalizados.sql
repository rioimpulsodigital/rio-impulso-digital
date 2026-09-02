-- RIO-119 (ampliación de alcance, 02/09/2026): proyectos personalizados
-- (ej. Nua Bushi — eCommerce + integración Laudus) — un proyecto con
-- diseño/desarrollo/integraciones que NO es Ficha, Landing ni Pack del
-- catálogo vigente. Brenda fue explícita: "sin modificar código y sin
-- clasificarlos falsamente como productos del catálogo vigente" — se
-- agrega UN solo valor nuevo y genérico ('proyecto_personalizado') que
-- sirve para éste y cualquier proyecto personalizado futuro, sin volver a
-- tocar el esquema cada vez.
--
-- SQLite no permite ALTERar un CHECK de una columna existente — las tres
-- tablas se reconstruyen con el patrón estándar (crear la nueva, copiar,
-- borrar la vieja, renombrar). Ningún dato existente se pierde ni se
-- reinterpreta; todas las columnas y valores actuales se preservan tal
-- cual. Esta migración NO carga ningún dato de Nua Bushi — ver RIO-119
-- para la regla de "construir el flujo genérico primero, con datos
-- ficticios en Preview".

PRAGMA foreign_keys=off;

-- ── ventas: agrega 'proyecto_personalizado' al CHECK de producto, más
--    nombre_proyecto/descripcion_proyecto/notion_url (nulos salvo para
--    este tipo de venta — un proyecto personalizado no tiene un nombre de
--    producto de catálogo, necesita el suyo propio + su página operativa
--    de Notion, nunca inferida).
CREATE TABLE ventas_new (
  id TEXT PRIMARY KEY,
  codigo_venta TEXT NOT NULL UNIQUE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  mercado TEXT NOT NULL CHECK (mercado IN ('CL', 'AR')),
  producto TEXT NOT NULL CHECK (producto IN ('ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado', 'proyecto_personalizado')),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  tipo_precio TEXT NOT NULL CHECK (tipo_precio IN ('regular', 'lanzamiento')),
  precio_pactado INTEGER NOT NULL CHECK (precio_pactado > 0),
  vendedor_email TEXT NOT NULL,
  estado_actual TEXT NOT NULL DEFAULT 'registrada',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  equipo_id TEXT REFERENCES equipos(id),
  idempotency_key TEXT,
  origen TEXT,
  es_demo INTEGER NOT NULL DEFAULT 0 CHECK (es_demo IN (0, 1)),
  antecedentes_kit_json TEXT,
  tipo_venta TEXT NOT NULL DEFAULT 'equipo' CHECK (tipo_venta IN ('equipo', 'directa_administracion_sin_supervision')),
  supervisor_snapshot_email TEXT,
  plan_supervision_snapshot_id TEXT,
  supervision_aplica INTEGER NOT NULL DEFAULT 1 CHECK (supervision_aplica IN (0, 1)),
  motivo_sin_supervision TEXT,
  porcentaje_supervision_aplicado INTEGER NOT NULL DEFAULT 10,
  porcentaje_final_empresa INTEGER NOT NULL DEFAULT 20,
  nombre_proyecto TEXT,
  descripcion_proyecto TEXT,
  notion_url TEXT
);
INSERT INTO ventas_new SELECT
  id, codigo_venta, cliente_id, mercado, producto, moneda, tipo_precio, precio_pactado, vendedor_email,
  estado_actual, created_at, equipo_id, idempotency_key, origen, es_demo, antecedentes_kit_json,
  tipo_venta, supervisor_snapshot_email, plan_supervision_snapshot_id, supervision_aplica, motivo_sin_supervision,
  porcentaje_supervision_aplicado, porcentaje_final_empresa,
  NULL, NULL, NULL
FROM ventas;
DROP TABLE ventas;
ALTER TABLE ventas_new RENAME TO ventas;

-- ── componentes: agrega 'personalizado' al CHECK de tipo, más nombre/
--    descripcion (la fase/hito del proyecto — ej. "Diseño UI", "Integración
--    Laudus" — nulos salvo para tipo='personalizado'). 'bloqueada' sigue
--    existiendo en estado_actual pero un componente personalizado nunca
--    la usa (ese gate es exclusivo del Landing de un Pack, sin cambios).
CREATE TABLE componentes_new (
  id TEXT PRIMARY KEY,
  proyecto_id TEXT NOT NULL REFERENCES proyectos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ficha', 'landing', 'personalizado')),
  precio_individual_referencia INTEGER NOT NULL,
  precio_atribuido INTEGER NOT NULL,
  estado_actual TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_actual IN ('bloqueada', 'pendiente', 'en_produccion', 'entregada', 'aprobada')),
  materiales_estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (materiales_estado IN ('pendiente', 'informados', 'completos')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  nombre TEXT,
  descripcion TEXT
);
INSERT INTO componentes_new SELECT
  id, proyecto_id, tipo, precio_individual_referencia, precio_atribuido, estado_actual, materiales_estado, created_at,
  NULL, NULL
FROM componentes;
DROP TABLE componentes;
ALTER TABLE componentes_new RENAME TO componentes;

-- ── pagos_esperados: agrega 'personalizado' al CHECK de tipo, más
--    etiqueta (el nombre libre del pago/hito de cobro — ej. "Pago inicial",
--    "Hito 2 — Integración" — nula salvo para tipo='personalizado'). Un
--    proyecto personalizado puede tener más de dos pagos (a diferencia del
--    catálogo, que siempre es 1 o 2) — esta tabla ya era 1-N por venta_id,
--    sin cambios en esa relación.
CREATE TABLE pagos_esperados_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('total', 'inicial', 'saldo', 'personalizado')),
  monto INTEGER NOT NULL CHECK (monto > 0),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'informado', 'acreditado')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  etiqueta TEXT
);
INSERT INTO pagos_esperados_new SELECT
  id, venta_id, tipo, monto, moneda, estado, created_at, NULL
FROM pagos_esperados;
DROP TABLE pagos_esperados;
ALTER TABLE pagos_esperados_new RENAME TO pagos_esperados;

PRAGMA foreign_keys=on;
