-- RIO-111 — Migración 0005
-- Falta detectada en auditoría de Brenda (28/08/2026): el modelo de RIO-111
-- (0003/0004) no tenía "mercado predeterminado" — un dato real que sí
-- existía en users.js (ej. Brenda: allowedMarkets ["CL","AR"], pero su
-- mercado por defecto es AR, no el primero de la lista). Sin esta columna,
-- D1 no podía reemplazar a users.js sin perder información.
--
-- No se edita la migración 0004 ya aplicada — se agrega la columna acá y se
-- completa el valor para las filas ya sembradas, siguiendo la misma
-- disciplina de "nunca editar una migración ya aplicada" de RIO-110.

ALTER TABLE asignaciones_rol ADD COLUMN default_market TEXT;

UPDATE asignaciones_rol SET default_market = 'AR'
WHERE usuario_id = (SELECT id FROM usuarios WHERE email = 'brenda@rioimpulsodigital.com')
  AND valid_until IS NULL;

UPDATE asignaciones_rol SET default_market = 'CL'
WHERE usuario_id = (SELECT id FROM usuarios WHERE email = 'albertoperezmatta@gmail.com')
  AND valid_until IS NULL;

-- El resto del plantel sembrado en 0004 tiene un solo mercado autorizado —
-- su "mercado predeterminado" es, por definición, el único que tienen.
UPDATE asignaciones_rol SET default_market = json_extract(allowed_markets, '$[0]')
WHERE default_market IS NULL AND valid_until IS NULL;
