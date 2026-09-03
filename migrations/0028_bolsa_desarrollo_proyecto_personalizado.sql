-- RIO-119 (tercer bloque, item 5 — versión completa, 03/09/2026): proyectos
-- personalizados activos con bolsa de desarrollo, plantillas económicas
-- configurables, fases enriquecidas, y modo de importación histórica.
--
-- Reemplaza el modelo simplificado de la migración 0027 (una sola
-- `distribucion` cargada de una vez, al crear la venta) por un flujo
-- borrador → confirmada, con "empresa" siempre como pool fijo reservado
-- (nunca una fila), y "desarrollo" como una BOLSA única del proyecto
-- completo (nunca un 45% por componente) que administración puede repartir
-- entre varias personas y fases, dejando temporalmente porciones
-- "Pendiente de asignación". `ventas.distribucion_snapshot` (0027) se
-- conserva como caché de solo lectura de la última distribución
-- CONFIRMADA — se sigue completando desde el código, ahora al activar.

-- Plantilla económica reutilizable — nunca hardcodeada por nombre de
-- proyecto ni de persona, siempre editable/desactivable. Estos porcentajes
-- son la base sobre la que se arman los pools de una distribución
-- concreta (venta_distribuciones) — la plantilla en sí NUNCA se aplica
-- automáticamente a una venta.
CREATE TABLE plantillas_distribucion (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  porcentaje_comercial INTEGER NOT NULL CHECK (porcentaje_comercial >= 0 AND porcentaje_comercial <= 100),
  porcentaje_supervision INTEGER NOT NULL CHECK (porcentaje_supervision >= 0 AND porcentaje_supervision <= 100),
  porcentaje_desarrollo INTEGER NOT NULL CHECK (porcentaje_desarrollo >= 0 AND porcentaje_desarrollo <= 100),
  porcentaje_empresa INTEGER NOT NULL CHECK (porcentaje_empresa >= 0 AND porcentaje_empresa <= 100),
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo')),
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (porcentaje_comercial + porcentaje_supervision + porcentaje_desarrollo + porcentaje_empresa = 100)
);

-- Distribución económica de UN proyecto — versionada (nunca se edita una
-- fila 'confirmada' in place: una corrección posterior cierra la vigente
-- como 'reemplazada' y crea una nueva 'borrador', con motivo obligatorio).
-- Los 3 porcentajes son los POOLS reservados para ese proyecto (copiados
-- de una plantilla o definidos a mano) — "empresa" nunca se guarda acá,
-- siempre se calcula como 100 menos estos tres.
CREATE TABLE venta_distribuciones (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  version INTEGER NOT NULL DEFAULT 1,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'confirmada', 'reemplazada')),
  plantilla_id TEXT REFERENCES plantillas_distribucion(id),
  porcentaje_comercial INTEGER NOT NULL DEFAULT 0 CHECK (porcentaje_comercial >= 0 AND porcentaje_comercial <= 100),
  porcentaje_supervision INTEGER NOT NULL DEFAULT 0 CHECK (porcentaje_supervision >= 0 AND porcentaje_supervision <= 100),
  porcentaje_desarrollo INTEGER NOT NULL DEFAULT 0 CHECK (porcentaje_desarrollo >= 0 AND porcentaje_desarrollo <= 100),
  motivo_correccion TEXT,
  confirmed_at TEXT,
  confirmed_by TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_venta_distribuciones_venta ON venta_distribuciones(venta_id);

-- Una fila = una participación económica concreta dentro de un pool
-- (comercial/supervisión/desarrollo). `beneficiario_email` NULL significa
-- "Pendiente de asignación" — nunca genera comisión personal ni puede
-- habilitarse para pago (ver _shared/comisiones.js validarActivacionProyecto).
-- `fase_id` es opcional — permite repartir la bolsa de desarrollo por
-- componente/fase sin que eso cree un pool adicional (sigue descontando
-- del mismo pool de desarrollo del proyecto).
CREATE TABLE venta_participaciones (
  id TEXT PRIMARY KEY,
  distribucion_id TEXT NOT NULL REFERENCES venta_distribuciones(id),
  concepto TEXT NOT NULL CHECK (concepto IN ('comercial', 'supervision', 'desarrollo')),
  fase_id TEXT REFERENCES componentes(id),
  beneficiario_email TEXT,
  porcentaje INTEGER NOT NULL CHECK (porcentaje > 0 AND porcentaje <= 100),
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_venta_participaciones_distribucion ON venta_participaciones(distribucion_id);

-- Fases enriquecidas (RIO-119, tercer bloque item 5) — columnas nuevas sin
-- CHECK sobre `componentes`, no requiere reconstruir la tabla (mismo
-- criterio que 0017/0023/0025/0027). `responsable_operativo_email` es la
-- asignación OPERATIVA (quién hace el trabajo) — deliberadamente
-- independiente de `venta_participaciones.beneficiario_email` (quién cobra
-- el %): una persona puede ser una sin ser la otra.
ALTER TABLE componentes ADD COLUMN orden INTEGER;
ALTER TABLE componentes ADD COLUMN responsable_operativo_email TEXT;
ALTER TABLE componentes ADD COLUMN fecha_prevista TEXT;
ALTER TABLE componentes ADD COLUMN fecha_real TEXT;

-- Modo de importación histórica (RIO-119, tercer bloque item 5): una venta
-- así marcada nunca inicia plazos, nunca genera notificaciones operativas
-- ni comisiones nuevas (ver _shared/notificaciones.js y
-- _shared/comisiones.js — ambas puertas centrales verifican esta columna),
-- nunca se sincroniza con HubSpot, y permite fases/pagos incompletos. NULL
-- en cualquier venta registrada por el flujo normal.
ALTER TABLE ventas ADD COLUMN modo_historico TEXT CHECK (modo_historico IS NULL OR modo_historico IN ('referencia', 'reconstruccion'));

-- Plantilla de referencia inicial para proyectos de desarrollo (sitio web,
-- eCommerce, automatizaciones, integraciones) — Brenda, 03/09/2026.
-- Editable/desactivable como cualquier plantilla; nunca se aplica sola,
-- ni a Nua Bushi ni a ningún proyecto, sin que administración la elija
-- explícitamente al definir los pools de esa venta.
INSERT INTO plantillas_distribucion (id, nombre, porcentaje_comercial, porcentaje_supervision, porcentaje_desarrollo, porcentaje_empresa, note, created_by)
VALUES (
  'plantilla-desarrollo-referencia-inicial',
  'Desarrollo web / eCommerce / automatizaciones / integraciones (referencia inicial)',
  25, 10, 45, 20,
  'Configuración de referencia inicial (Brenda, 03/09/2026) — punto de partida editable, nunca se aplica automáticamente a un proyecto real sin confirmación explícita de participantes y porcentajes.',
  'sistema'
);
