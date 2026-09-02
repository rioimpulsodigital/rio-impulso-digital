-- RIO-118 (corrección — ventas administrativas y comisión de
-- supervisión, 01/09/2026): la comisión de supervisión depende de que la
-- venta esté vinculada a un EQUIPO SUPERVISADO, nunca del rol principal
-- ni del nombre del vendedor — esto ya era así en el código (RIO-115),
-- pero faltaba una forma DELIBERADA y auditable de que administración
-- registre una venta SIN equipo (nunca por accidente de no estar en
-- ningún equipo_miembros).
--
-- tipo_venta distingue esa decisión explícita ('equipo' es el default —
-- incluye tanto una venta con equipo real como una venta sin equipo por
-- vacío estructural, ej. un vendedor sin asignación; nunca se confunde
-- con la elección deliberada 'directa_administracion_sin_supervision',
-- que además siempre trae motivo_sin_supervision poblado).
--
-- El resto de las columnas son SNAPSHOT inmutable al momento de crear la
-- venta — igual criterio que precio_pactado/moneda/equipo_id desde
-- RIO-112/115: nunca se recalculan después si cambia el supervisor o el
-- plan vigente. Solo ALTER TABLE ADD COLUMN, ningún CHECK existente cambia.

ALTER TABLE ventas ADD COLUMN tipo_venta TEXT NOT NULL DEFAULT 'equipo' CHECK (tipo_venta IN ('equipo', 'directa_administracion_sin_supervision'));
ALTER TABLE ventas ADD COLUMN supervisor_snapshot_email TEXT;
ALTER TABLE ventas ADD COLUMN plan_supervision_snapshot_id TEXT;
ALTER TABLE ventas ADD COLUMN supervision_aplica INTEGER NOT NULL DEFAULT 1 CHECK (supervision_aplica IN (0, 1));
ALTER TABLE ventas ADD COLUMN motivo_sin_supervision TEXT;
-- Los valores por defecto (10/20) son la base confirmada desde RIO-115
-- para toda venta previa a esta corrección — no una afirmación retroactiva
-- de qué pasó realmente en cada una: el detalle de una venta muestra su
-- tipo real usando equipo_id (ya existente y confiable), nunca estas
-- columnas nuevas por sí solas, para una venta creada antes de hoy.
ALTER TABLE ventas ADD COLUMN porcentaje_supervision_aplicado INTEGER NOT NULL DEFAULT 10;
ALTER TABLE ventas ADD COLUMN porcentaje_final_empresa INTEGER NOT NULL DEFAULT 20;
