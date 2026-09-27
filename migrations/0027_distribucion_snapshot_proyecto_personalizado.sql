-- RIO-119 (tercer bloque, item 5, 02/09/2026): preparación para registrar
-- proyectos personalizados con una distribución económica propia (ej. Nua
-- Bushi) — "mantener un snapshot inmutable de la distribución aprobada".
--
-- Se agrega una columna nueva sin CHECK sobre una tabla existente — no
-- requiere reconstruir la tabla (a diferencia de ALTERar el CHECK de una
-- columna ya existente, que SQLite no permite — ver migraciones 0024/0025).
--
-- `distribucion_snapshot` guarda el JSON devuelto por
-- `validarDistribucion()` (_shared/comisiones.js) en el momento exacto en
-- que administración registró el proyecto — participaciones, porcentajes,
-- y el remanente de empresa. Es informativo/auditable: un snapshot
-- congelado de lo aprobado, nunca recalculado después. Se completa
-- únicamente para producto = 'proyecto_personalizado'; en cualquier otro
-- producto queda NULL (la distribución de catálogo se resuelve como
-- siempre, vía planes_comision + asignaciones_plan_comision).

ALTER TABLE ventas ADD COLUMN distribucion_snapshot TEXT;
