-- RIO-114 (corrección final) — Migración 0012
-- Brenda confirmó las 3 decisiones económicas que quedaban pendientes
-- desde la corrección anterior (30/08/2026). Ninguna requiere cambios de
-- esquema ni de código — el modelo de planes/asignaciones versionadas ya
-- soporta genéricamente que una misma persona acumule más de un tipo de
-- comisión sobre la misma venta. Esto es solo la semilla de datos que
-- faltaba para que ese comportamiento ya soportado se active de verdad.

-- 1) Un administrador que vende puede tener un plan comercial de 0% — una
-- fila de comisión visible y auditable (nunca "sin plan"), sin pagar
-- comisión; la utilidad permanece en RiO. Se asigna a Brenda porque hoy es
-- quien efectivamente vende como admin, pero el mecanismo es genérico: no
-- hay ninguna condición de código atada a su nombre — cualquier usuario
-- con este mismo plan se comporta exactamente igual.
INSERT INTO planes_comision (id, tipo, porcentaje, base, productos_alcanzados, mercados_alcanzados, created_by, note) VALUES
  ('plan-comercial-0', 'comercial', 0, 'utilidad_neta_venta', '["ficha","generico","personalizado","ficha_generico","ficha_personalizado"]', '["CL","AR"]', 'rio-114-seed-v3', 'Confirmado por Brenda 30/08/2026 — un administrador que vende puede tener comisión comercial 0%, registrada para trazabilidad, sin pagar comisión. La utilidad permanece en RiO.');

INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-comercial-0', 'rio-114-seed-v3', 'Semilla — Brenda vende como admin, plan comercial 0% confirmado 30/08/2026'
FROM usuarios u WHERE u.email = 'brenda@rioimpulsodigital.com';

-- 2) Un supervisor que también vende personalmente acumula comercial (si
-- tiene ese plan) + supervisión (si tiene ese plan) sobre la MISMA venta,
-- como dos filas independientes — el código ya lo soporta (el listado de
-- supervisores activos no excluye al propio vendedor de recibir además su
-- comisión comercial). Alberto pasa a tener también el plan comercial 40%
-- ya existente (mismo plan que usan los ejecutivos), sumado a su
-- supervisión 10% ya asignada desde la migración 0011.
INSERT INTO asignaciones_plan_comision (id, usuario_id, plan_id, created_by, note)
SELECT lower(hex(randomblob(16))), u.id, 'plan-comercial-40', 'rio-114-seed-v3', 'Semilla — Alberto vende personalmente además de supervisar; comercial 40% confirmado 30/08/2026, se acumula con su supervisión 10%'
FROM usuarios u WHERE u.email = 'albertoperezmatta@gmail.com';

-- 3) Asistente que vende y produce: ya soportado por el modelo existente
-- sin necesitar ninguna fila nueva (comercial vía can_sell + plan
-- comercial vigente; producción vía asignaciones_produccion + plan de
-- producción vigente, ya sembrado en la migración 0011) — no hay ningún
-- asistente en el plantel todavía, así que no hay nada que sembrar acá.
