-- RIO-118 (corrección funcional — materiales por correo central,
-- 01/09/2026): el cliente entrega materiales al ejecutivo, que los
-- reenvía a venta@rioimpulsodigital.com — el correo es la fuente
-- documental real, el Portal NUNCA almacena los archivos (ni ahora ni
-- todavía en R2). Lo que el Portal registra es el HECHO de cada entrega
-- y su revisión administrativa.
--
-- Reemplaza el modelo de "una sola informada, admin resetea a pendiente
-- para reintentar" (RIO-117) por un registro SIEMPRE abierto: cada
-- entrega es un evento nuevo e inmutable (numerado, con su propio estado
-- de revisión de 5 valores) — "Materiales completos" en el componente ya
-- NUNCA cierra el botón de informar ni oculta el registro.
--
-- Se extiende materiales_informados_detalle (ya existía desde la
-- migración 0020) en vez de crear una tabla paralela — mismo criterio de
-- "auditar antes de duplicar" pedido por Brenda. Solo ALTER TABLE ADD
-- COLUMN, ningún CHECK existente cambia.

ALTER TABLE materiales_informados_detalle ADD COLUMN numero_entrega INTEGER NOT NULL DEFAULT 1;
ALTER TABLE materiales_informados_detalle ADD COLUMN descripcion TEXT NOT NULL DEFAULT '';
ALTER TABLE materiales_informados_detalle ADD COLUMN cantidad_archivos_aprox INTEGER;
ALTER TABLE materiales_informados_detalle ADD COLUMN correo_destino TEXT NOT NULL DEFAULT 'venta@rioimpulsodigital.com';
ALTER TABLE materiales_informados_detalle ADD COLUMN estado_revision TEXT NOT NULL DEFAULT 'informada' CHECK (estado_revision IN ('informada', 'en_revision', 'aceptada', 'requiere_material_adicional', 'descartada_con_motivo'));
ALTER TABLE materiales_informados_detalle ADD COLUMN revisado_por TEXT;
ALTER TABLE materiales_informados_detalle ADD COLUMN revisado_en TEXT;
ALTER TABLE materiales_informados_detalle ADD COLUMN motivo_revision TEXT;

CREATE INDEX IF NOT EXISTS idx_materiales_informados_estado_revision ON materiales_informados_detalle (componente_id, estado_revision);
