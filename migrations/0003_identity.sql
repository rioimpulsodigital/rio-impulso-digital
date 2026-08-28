-- RIO-111 — Migración 0003
-- Fuente única de identidad, roles y mercados autorizados — reemplaza a
-- USER_MAP (interno/config/users.js) como fuente de autoridad para permisos
-- y datos financieros. `users.js` se mantiene tal cual para lo que ya hace
-- bien (personalización de interfaz sin datos financieros — ver RIO-97 v2
-- sección 19); esta tabla nunca se lee desde el navegador.
--
-- Principio de diseño (RIO-97 v2 sección 4): ninguna regla de negocio dice
-- "si el email es X" — todo permiso se resuelve leyendo `role`,
-- `allowed_markets`, `user_status` y la vigencia. Sin lógica por nombre
-- propio en ningún archivo .js — solo en los datos de esta tabla.

-- Identidad — un registro por persona. El email es el ancla: es el mismo
-- valor que entrega el JWT de Cloudflare Access ya verificado (RIO-110,
-- functions/_shared/access.js). No hay contraseña, login propio ni ningún
-- otro campo de autenticación acá — la autenticación es exclusivamente de
-- Access; esta tabla es autorización, nunca un segundo sistema de login.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Asignación de rol y mercados — versionada en el tiempo (RIO-97 v2 sección 4:
-- "validFrom"/"validUntil" en cada asignación). Nunca se edita ni se borra una
-- fila ya cerrada (valid_until definido): un cambio de rol o mercado cierra
-- la fila vigente (UPDATE de valid_until, único campo que se toca) e inserta
-- una fila nueva — el historial de qué rol/mercado tuvo cada persona en cada
-- momento queda intacto para siempre. "Vigente" = valid_until IS NULL (o
-- futura) AND user_status = 'activo'.
--
-- allowed_markets: JSON de mercados ISO ("CL"/"AR"), ej. '["CL"]' o
-- '["CL","AR"]'. Mismo significado que allowedMarkets en users.js — un solo
-- mercado no necesita selector; varios, el usuario elige entre los suyos
-- (comportamiento ya implementado en el frontend, sin cambios en RIO-111).
CREATE TABLE IF NOT EXISTS asignaciones_rol (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'ejecutivo', 'asistente')),
  allowed_markets TEXT NOT NULL,
  user_status TEXT NOT NULL DEFAULT 'activo' CHECK (user_status IN ('activo', 'inactivo')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_asignaciones_rol_usuario ON asignaciones_rol (usuario_id);

-- Acelera la consulta "cuál es la asignación vigente de este usuario ahora"
-- (WHERE usuario_id = ? AND (valid_until IS NULL OR valid_until > ?)),
-- que corre en cada solicitud a /interno/api/identidad/* (ver authz.js).
CREATE INDEX IF NOT EXISTS idx_asignaciones_rol_vigencia ON asignaciones_rol (usuario_id, valid_until);
