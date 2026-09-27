-- RIO-114 — Migración 0010
-- eventos_historial.entidad tenía un CHECK que no incluía 'comision' — se
-- agrega para poder registrar los cambios de estado de la máquina de 9
-- estados de la comisión (RIO-97 v2 sección 8) en el mismo historial
-- append-only que ya usan venta/proyecto/componente/pago/incidencia. Mismo
-- patrón de recreación de tabla que 0007/0008 (SQLite no permite alterar un
-- CHECK existente). Sin riesgo de datos: eventos_historial en preview solo
-- tiene los eventos ya generados por las verificaciones de RIO-113,
-- ninguno con entidad='comision' todavía.

PRAGMA foreign_keys = OFF;

CREATE TABLE eventos_historial_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  entidad TEXT NOT NULL CHECK (entidad IN ('venta', 'proyecto', 'componente', 'pago', 'incidencia', 'comision')),
  entidad_id TEXT NOT NULL,
  estado_anterior TEXT,
  estado_nuevo TEXT NOT NULL,
  usuario_email TEXT NOT NULL,
  motivo_nota TEXT,
  proxima_accion TEXT,
  responsable_proxima_accion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO eventos_historial_new (id, venta_id, entidad, entidad_id, estado_anterior, estado_nuevo, usuario_email, motivo_nota, proxima_accion, responsable_proxima_accion, created_at)
SELECT id, venta_id, entidad, entidad_id, estado_anterior, estado_nuevo, usuario_email, motivo_nota, proxima_accion, responsable_proxima_accion, created_at FROM eventos_historial;

DROP TABLE eventos_historial;
ALTER TABLE eventos_historial_new RENAME TO eventos_historial;
CREATE INDEX IF NOT EXISTS idx_eventos_historial_venta ON eventos_historial (venta_id);

PRAGMA foreign_keys = ON;

-- incidencias necesita una acción de "resolver" para que la condición
-- "venta firme y sin disputa" de la comisión pueda dejar de estar bloqueada
-- si la disputa se resuelve — hoy la columna existe (migración 0007) pero
-- ningún endpoint la usa todavía.
