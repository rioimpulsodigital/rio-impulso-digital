-- RIO-118 (corrección — decisiones de Brenda sobre identidad visible,
-- equipos y referente comercial, 01/09/2026):
--   1. usuarios.whatsapp_laboral: número de contacto laboral del
--      supervisor, normalizado (solo dígitos, formato internacional sin
--      "+" ni espacios) — NUNCA un dato personal. Nace NULL para todos
--      (el número real de Alberto todavía no fue entregado); RIO-119
--      permitirá cargarlo desde el Panel Administrativo.
--   2. equipo_supervisores.es_principal: distingue, entre los supervisores
--      VIGENTES de un mismo equipo (hoy siempre uno solo por convención de
--      código, pero el modelo debe admitir más de uno a futuro), cuál es
--      el referente principal de contacto — "Mi referente comercial" en
--      el Panel del Vendedor se resuelve por esta columna, nunca
--      asumiendo "el único que hay".
--
-- No se reconstruye ninguna tabla — ambas son ALTER TABLE ADD COLUMN
-- simples, sin tocar ningún CHECK existente.

ALTER TABLE usuarios ADD COLUMN whatsapp_laboral TEXT;

ALTER TABLE equipo_supervisores ADD COLUMN es_principal INTEGER NOT NULL DEFAULT 0 CHECK (es_principal IN (0, 1));

-- Alberto es hoy el único supervisor de sus dos equipos (CL y AR,
-- sembrados en la migración 0015) — se marca principal en ambos.
UPDATE equipo_supervisores SET es_principal = 1
WHERE usuario_email = 'albertoperezmatta@gmail.com' AND valid_until IS NULL;
