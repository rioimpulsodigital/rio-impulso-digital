-- RIO-113 (corrección) — Migración 0008
-- Decisiones definitivas de Brenda (28/08/2026) sobre el modelo de
-- permisos: separa el rol principal de la capacidad para vender, y deja
-- de asumir que solo un Ejecutivo vende — un Administrador, un
-- Supervisor o un Asistente/practicante con la capacidad habilitada
-- también pueden figurar como vendedores de una venta.

-- can_sell es una capacidad más, versionada junto con el rol y el
-- mercado en la misma fila de asignaciones_rol — mismo criterio de
-- vigencia que ya usan role/allowed_markets/default_market (nunca se
-- edita una fila cerrada; un cambio de capacidad cierra la vigente e
-- inserta una nueva).
ALTER TABLE asignaciones_rol ADD COLUMN can_sell INTEGER NOT NULL DEFAULT 0;

-- Todo el plantel sembrado en RIO-111 (migración 0004) hoy vende en la
-- práctica — son quienes hoy registran ventas — así que su asignación
-- vigente queda con can_sell = 1 para no cambiarles el comportamiento
-- real que ya tenían.
UPDATE asignaciones_rol SET can_sell = 1 WHERE valid_until IS NULL;

-- ventas.ejecutivo_email -> vendedor_email: mismo dato (el email de
-- quien vendió), nombre genérico porque la persona vendedora puede
-- tener cualquier rol, no solo Ejecutivo (Brenda, sección 2 de su
-- corrección: "Utilizá preferentemente un campo genérico... porque la
-- persona vendedora no necesariamente tendrá rol Ejecutivo").
ALTER TABLE ventas RENAME COLUMN ejecutivo_email TO vendedor_email;
DROP INDEX IF EXISTS idx_ventas_ejecutivo;
CREATE INDEX IF NOT EXISTS idx_ventas_vendedor ON ventas (vendedor_email);

-- materiales_estado pasaba directo de 'pendiente' a 'completos'. Ahora
-- distingue "el vendedor avisa que recibió archivos" (informados — dato
-- reportado, no oficial) de "los archivos alcanzan para producción"
-- (completos — validación exclusiva de administración). Brenda, sección
-- 4 de su corrección: "los datos informados nunca deben avanzar
-- automáticamente el proyecto". Mismo patrón de recreación de tabla que
-- la migración 0007 (SQLite no permite alterar un CHECK existente con
-- ALTER TABLE). Sin riesgo de datos: no hay componentes reales en
-- preview — los únicos insertados durante la verificación de RIO-113 ya
-- se borraron.
PRAGMA foreign_keys = OFF;

CREATE TABLE componentes_new (
  id TEXT PRIMARY KEY,
  proyecto_id TEXT NOT NULL REFERENCES proyectos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ficha', 'landing')),
  precio_individual_referencia INTEGER NOT NULL,
  precio_atribuido INTEGER NOT NULL,
  estado_actual TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_actual IN ('bloqueada', 'pendiente', 'en_produccion', 'entregada', 'aprobada')),
  materiales_estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (materiales_estado IN ('pendiente', 'informados', 'completos')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO componentes_new (id, proyecto_id, tipo, precio_individual_referencia, precio_atribuido, estado_actual, materiales_estado, created_at)
SELECT id, proyecto_id, tipo, precio_individual_referencia, precio_atribuido, estado_actual, materiales_estado, created_at FROM componentes;

DROP TABLE componentes;
ALTER TABLE componentes_new RENAME TO componentes;
CREATE INDEX IF NOT EXISTS idx_componentes_proyecto ON componentes (proyecto_id);

PRAGMA foreign_keys = ON;
