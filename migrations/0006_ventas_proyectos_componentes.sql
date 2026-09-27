-- RIO-112 — Migración 0006
-- Entidades centrales del modelo comercial: clientes, ventas, proyectos y
-- componentes — separadas y auditables, tal como exige RIO-97 v2 sección 6
-- y los criterios de aceptación de RIO-112. NO incluye máquina de estados
-- completa (RIO-113) ni comisiones (RIO-114) — a propósito, fuera de
-- alcance de esta tarea.
--
-- Reutiliza la identidad de RIO-111 (ejecutivo_email/mercado se validan
-- contra usuarios/asignaciones_rol vía authz.js — no se duplica esa lógica
-- acá, ni se agrega una columna de "supervisor" porque quién supervisa qué
-- mercado ya lo resuelve la asignación de rol vigente, no un snapshot en
-- cada venta).
--
-- Decisión de diseño — id como TEXT (UUID), no INTEGER AUTOINCREMENT como
-- en usuarios/asignaciones_rol (RIO-111): una venta crea en cascada un
-- cliente + una venta + un proyecto + 1-2 componentes, y D1 solo garantiza
-- atomicidad real dentro de un único db.batch() (confirmado en la
-- auditoría RIO-108, sección 5) — un batch no puede usar el id generado
-- por una sentencia anterior del mismo batch. Generando los id como UUID
-- en el Worker ANTES de tocar la base, las 4-5 inserciones viajan en un
-- solo batch atómico (todo o nada) sin necesitar ese encadenamiento.

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  negocio TEXT NOT NULL,
  contacto_nombre TEXT,
  telefono TEXT,
  email TEXT,
  mercado TEXT NOT NULL CHECK (mercado IN ('CL', 'AR')),
  datos_facturacion_ar TEXT, -- JSON opcional, solo se completa en mercado AR
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Venta ≠ Proyecto ≠ Componente (RIO-97 v2 sección 6): tres tablas
-- distintas, nunca una sola con banderas.
CREATE TABLE IF NOT EXISTS ventas (
  id TEXT PRIMARY KEY,
  -- Código legible para humanos — fecha + sufijo corto, no secuencial: no
  -- depende de un contador (que rompería la atomicidad del batch, ver
  -- arriba) ni de una segunda ida y vuelta a la base para saber "el próximo
  -- número".
  codigo_venta TEXT NOT NULL UNIQUE,
  cliente_id TEXT NOT NULL REFERENCES clientes(id),
  mercado TEXT NOT NULL CHECK (mercado IN ('CL', 'AR')),
  producto TEXT NOT NULL CHECK (producto IN ('ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado')),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  tipo_precio TEXT NOT NULL CHECK (tipo_precio IN ('regular', 'lanzamiento')),
  precio_pactado INTEGER NOT NULL CHECK (precio_pactado > 0),
  ejecutivo_email TEXT NOT NULL,
  -- Placeholder mínimo — RIO-113 implementa la máquina de estados completa
  -- (20 estados en pack, secuencial Ficha→Landing, RIO-97 v2 sección 7
  -- reescrita). No se anticipa esa lógica acá.
  estado_actual TEXT NOT NULL DEFAULT 'registrada',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ventas_ejecutivo ON ventas (ejecutivo_email);
CREATE INDEX IF NOT EXISTS idx_ventas_mercado ON ventas (mercado);
CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas (cliente_id);

CREATE TABLE IF NOT EXISTS proyectos (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL UNIQUE REFERENCES ventas(id),
  codigo_proyecto TEXT NOT NULL UNIQUE,
  estado_actual TEXT NOT NULL DEFAULT 'registrado',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 1 fila si es individual (Ficha, Landing Express o Landing Premium solas),
-- 2 filas si es pack (ficha + landing) — RIO-97 v2 sección 6.
CREATE TABLE IF NOT EXISTS componentes (
  id TEXT PRIMARY KEY,
  proyecto_id TEXT NOT NULL REFERENCES proyectos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ficha', 'landing')),
  -- Snapshot al momento de la venta — nunca recalculado si los precios
  -- cambian después (RIO-97 v2 sección 6).
  precio_individual_referencia INTEGER NOT NULL,
  precio_atribuido INTEGER NOT NULL,
  -- Pack: 'ficha' arranca en 'pendiente' (primera en la secuencia), 'landing'
  -- arranca en 'bloqueada' — nunca puede empezar antes que la Ficha esté
  -- aprobada, el segundo pago acreditado y sus materiales completos (regla
  -- de Brenda del 27/08/2026, RIO-97 v2 sección 7 reescrita). Individual:
  -- único componente, arranca en 'pendiente'. La transición entre estados
  -- es responsabilidad de RIO-113 — acá solo se fija el punto de partida
  -- correcto para que el modelo nunca represente un pack en paralelo.
  estado_actual TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_actual IN ('pendiente', 'bloqueada')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_componentes_proyecto ON componentes (proyecto_id);
