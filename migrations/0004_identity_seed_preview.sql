-- RIO-111 — Migración 0004
-- Semilla de datos para PREVIEW/DESARROLLO únicamente — refleja el mismo
-- plantel vigente en interno/config/users.js al 28/08/2026 (ya sin Pablo,
-- ya con Manuel Christian renombrado), con rol asignado según lo ya
-- confirmado por Brenda en RIO-97 v2 (Brenda = admin, Alberto = supervisor,
-- el resto = ejecutivo — sección 4, "Asignación inicial (dato de ejemplo,
-- no lógica)"). Ningún .js de este proyecto contiene estos correos como
-- condición de código — viven solo acá, como datos.
--
-- NO ejecutar tal cual contra una futura base de producción sin revisión:
-- el plantel real puede cambiar antes de esa migración, y esta semilla no
-- tiene la disciplina de aprobación que requiere dar de alta gente en
-- producción (ver RIO-125, alta/baja de ejecutivos). Sirve para probar
-- whoami/autorización con datos realistas en rio-ventas-preview.
--
-- created_by = 'rio-111-seed-seed' marca estas filas como semilla de
-- migración, distinguible de una alta real hecha por un admin desde el
-- futuro panel administrativo (RIO-119).

INSERT INTO usuarios (email, nombre) VALUES
  ('brenda@rioimpulsodigital.com', 'Brenda'),
  ('albertoperezmatta@gmail.com', 'Alberto'),
  ('gabrielaaleroa@gmail.com', 'Gabriela'),
  ('jotaherre024@gmail.com', 'Julia'),
  ('lorenaramirezfuentealba@gmail.com', 'Lorena'),
  ('fjamis@gmail.com', 'Fuad'),
  ('mchristian.reyes@gmail.com', 'Manuel Christian'),
  ('araujochristianwalterdejesus@gmail.com', 'Christian'),
  ('lore_1212@hotmail.com', 'Nina'),
  ('mholsbachperalta@gmail.com', 'Maira');

INSERT INTO asignaciones_rol (usuario_id, role, allowed_markets, user_status, created_by, note)
SELECT id, 'admin', '["CL","AR"]', 'activo', 'rio-111-seed', 'Semilla RIO-111 — plantel vigente 28/08/2026'
FROM usuarios WHERE email = 'brenda@rioimpulsodigital.com';

INSERT INTO asignaciones_rol (usuario_id, role, allowed_markets, user_status, created_by, note)
SELECT id, 'supervisor', '["CL","AR"]', 'activo', 'rio-111-seed', 'Semilla RIO-111 — plantel vigente 28/08/2026'
FROM usuarios WHERE email = 'albertoperezmatta@gmail.com';

INSERT INTO asignaciones_rol (usuario_id, role, allowed_markets, user_status, created_by, note)
SELECT id, 'ejecutivo', '["CL"]', 'activo', 'rio-111-seed', 'Semilla RIO-111 — plantel vigente 28/08/2026'
FROM usuarios WHERE email IN (
  'gabrielaaleroa@gmail.com',
  'jotaherre024@gmail.com',
  'lorenaramirezfuentealba@gmail.com',
  'fjamis@gmail.com',
  'mchristian.reyes@gmail.com'
);

INSERT INTO asignaciones_rol (usuario_id, role, allowed_markets, user_status, created_by, note)
SELECT id, 'ejecutivo', '["AR"]', 'activo', 'rio-111-seed', 'Semilla RIO-111 — plantel vigente 28/08/2026'
FROM usuarios WHERE email IN (
  'araujochristianwalterdejesus@gmail.com',
  'lore_1212@hotmail.com',
  'mholsbachperalta@gmail.com'
);
