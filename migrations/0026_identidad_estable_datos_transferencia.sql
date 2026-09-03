-- RIO-119 (tercer bloque — identidad estable y datos de transferencia
-- cifrados, 02/09/2026).
--
-- usuarios_correos_historicos: registro append-only de cada cambio de
-- correo — permite que un lookup por un correo ANTERIOR (ej. al resolver
-- el nombre de quien actuó en un evento histórico ya registrado con ese
-- correo, que deliberadamente NUNCA se reescribe) siga encontrando a la
-- misma persona. Las tablas de identidad activa (ventas.vendedor_email,
-- comisiones.beneficiario_email, equipo_miembros/equipo_supervisores.
-- usuario_email, asignaciones_realizacion.usuario_email,
-- materiales_informados_detalle.informado_por/revisado_por,
-- materiales_confirmaciones.admin_email, notificaciones.vendedor_email,
-- datos_transferencia.usuario_email) SÍ se actualizan en cascada al
-- cambiar un correo (son relaciones de identidad vigente, no hechos
-- históricos congelados) — eso lo hace la acción 'cambiar-correo' de
-- personas/[email]/index.js, no esta migración.
CREATE TABLE usuarios_correos_historicos (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  correo_anterior TEXT NOT NULL,
  correo_nuevo TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usuarios_correos_historicos_anterior ON usuarios_correos_historicos (correo_anterior);
CREATE INDEX idx_usuarios_correos_historicos_usuario ON usuarios_correos_historicos (usuario_id);

-- datos_transferencia: una persona puede tener más de un registro (por
-- país/proveedor). Campos verdaderamente sensibles cifrados en la
-- aplicación (functions/_shared/crypto.js, AES-GCM) ANTES de llegar acá —
-- esta tabla nunca ve el texto plano. banco/tipo_cuenta/tipo_documento/
-- moneda/país quedan sin cifrar: son metadatos categóricos, no
-- identificadores. 'eliminar' es un soft-delete (estado='inactivo') —
-- nunca se borra una fila, mismo criterio de auditoría que el resto del
-- sistema.
CREATE TABLE datos_transferencia (
  id TEXT PRIMARY KEY,
  usuario_email TEXT NOT NULL REFERENCES usuarios(email),
  pais TEXT NOT NULL CHECK (pais IN ('CL', 'AR')),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  banco_proveedor TEXT NOT NULL,
  tipo_cuenta TEXT,
  tipo_documento TEXT,
  titular_cifrado TEXT,
  identificacion_cifrada TEXT,
  numero_cuenta_cifrado TEXT,
  alias_cifrado TEXT,
  observaciones_cifradas TEXT,
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  updated_at TEXT
);
CREATE INDEX idx_datos_transferencia_usuario ON datos_transferencia (usuario_email, estado);
