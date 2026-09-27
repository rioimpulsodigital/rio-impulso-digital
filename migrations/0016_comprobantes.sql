-- RIO-116 — Migración 0016
-- Metadatos de los comprobantes reales (R2) — el archivo en sí vive en el
-- bucket privado `rio-comprobantes-preview` (binding COMPROBANTES); esta
-- tabla es el registro auditable de cada versión subida: quién, cuándo,
-- qué tamaño, qué tipo, y el hash del contenido real.
--
-- `referencia_id` es deliberadamente polimórfico (sin FK): según `tipo`
-- apunta a `pagos_informados.id` ('pago'), `conversiones.id`
-- ('conversion') o `transferencias_comision.id` ('transferencia') — tres
-- tablas distintas, no se puede declarar una sola FK. La integridad se
-- valida en código (comprobantes.js), no en el esquema.
--
-- Versionado (Brenda: "una corrección debe crear una nueva versión y
-- conservar la anterior — no sobrescribir ni eliminar silenciosamente"):
-- cada re-subida para el mismo (tipo, referencia_id) inserta una fila
-- NUEVA con version+1 y `vigente=1`, y la fila anterior pasa a
-- `vigente=0` — nunca se hace UPDATE del archivo ni DELETE de la fila. El
-- objeto R2 de la versión anterior tampoco se borra (su `r2_key` sigue
-- siendo válido) — solo deja de ser "el vigente".

CREATE TABLE IF NOT EXISTS comprobantes (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('pago', 'conversion', 'transferencia')),
  referencia_id TEXT NOT NULL,
  venta_id TEXT REFERENCES ventas(id), -- NULL para 'conversion'/'transferencia' que agrupan varias ventas.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  vigente INTEGER NOT NULL DEFAULT 1 CHECK (vigente IN (0, 1)),
  r2_key TEXT NOT NULL UNIQUE,
  nombre_original TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  tamano_bytes INTEGER NOT NULL CHECK (tamano_bytes > 0 AND tamano_bytes <= 10485760), -- 10 MB, límite inicial confirmado por Brenda.
  hash_sha256 TEXT NOT NULL,
  subido_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comprobantes_referencia ON comprobantes (tipo, referencia_id, vigente);
CREATE INDEX IF NOT EXISTS idx_comprobantes_venta ON comprobantes (venta_id);

-- eventos_historial gana 'comprobante' como entidad válida — mismo patrón
-- de recreación que 0008/0010/0013 (SQLite no permite alterar un CHECK
-- existente). D1 exige FK en cada sentencia (ver notas técnicas de 0014/
-- 0015): eventos_historial no tiene FK entrante de nadie, se recrea
-- directo sin necesidad de tocar otras tablas.
PRAGMA foreign_keys = OFF;

CREATE TABLE eventos_historial_new (
  id TEXT PRIMARY KEY,
  venta_id TEXT,
  entidad TEXT NOT NULL CHECK (entidad IN ('venta', 'proyecto', 'componente', 'pago', 'incidencia', 'comision', 'conversion', 'liquidacion', 'comprobante')),
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
