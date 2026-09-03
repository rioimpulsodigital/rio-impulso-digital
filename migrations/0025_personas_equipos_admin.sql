-- RIO-119 (segundo bloque — administración de personas y equipos,
-- 02/09/2026): prepara el esquema para que el Panel Administrativo pueda
-- crear/editar perfiles, cambiar rol/mercados/capacidad de vender, crear y
-- desactivar equipos, y asignar miembros/supervisores — todo lo que hoy
-- solo existe sembrado por migración SQL directa (RIO-115/118).
--
-- Datos de transferencia (cifrados/enmascarados) y planes de comisión
-- editables quedan para un bloque posterior de esta misma tarea — esta
-- migración no los incluye.

-- ── usuarios: datos de perfil que Brenda pidió poder administrar. Todos
--    nulos por defecto — ninguno se completa retroactivamente para el
--    plantel ya sembrado (RIO-111/112).
ALTER TABLE usuarios ADD COLUMN documento_identidad TEXT;
ALTER TABLE usuarios ADD COLUMN telefono TEXT;
-- Estado de incorporación al Portal — NUNCA automatiza Cloudflare Access
-- (eso es RIO-128, deliberadamente separado). Es solo lo que
-- administración registra a mano después de habilitar el acceso real.
ALTER TABLE usuarios ADD COLUMN acceso_estado TEXT NOT NULL DEFAULT 'perfil_creado'
  CHECK (acceso_estado IN ('perfil_creado', 'acceso_pendiente', 'acceso_confirmado', 'desactivado'));

-- ── equipos: hoy no tenía ningún estado — "crear y desactivar equipos"
--    lo requiere explícitamente.
ALTER TABLE equipos ADD COLUMN estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo'));

-- ── eventos_historial: el CHECK de entidad no admitía nada de personas/
--    equipos — SQLite no permite ALTERar un CHECK existente, se
--    reconstruye con el mismo patrón ya usado en 0010/0013/0016/0024.
--    Se agregan también los valores de planes de comisión ahora (aunque
--    ese bloque todavía no se implementa) para no reconstruir esta tabla
--    una segunda vez — sigue siendo el mismo alcance ya confirmado de
--    "administración de personas y equipos" en RIO-119.
PRAGMA foreign_keys=off;

CREATE TABLE eventos_historial_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT,
  entidad TEXT NOT NULL CHECK (entidad IN (
    'venta', 'proyecto', 'componente', 'pago', 'incidencia', 'comision', 'conversion', 'liquidacion', 'comprobante',
    'usuario', 'asignacion_rol', 'equipo', 'equipo_miembro', 'equipo_supervisor', 'plan_comision', 'asignacion_plan_comision'
  )),
  entidad_id TEXT NOT NULL,
  estado_anterior TEXT,
  estado_nuevo TEXT NOT NULL,
  usuario_email TEXT NOT NULL,
  motivo_nota TEXT,
  proxima_accion TEXT,
  responsable_proxima_accion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO eventos_historial_new SELECT * FROM eventos_historial;
DROP TABLE eventos_historial;
ALTER TABLE eventos_historial_new RENAME TO eventos_historial;

PRAGMA foreign_keys=on;
