-- RIO-119 (sexto bloque — cierre técnico, 04/09/2026):
--   1. Sin cambio de esquema (ver comentario más abajo).
--   2. Cumplimiento automático de los 10 días — sin cambio de esquema
--      (se resuelve reevaluando de forma perezosa e idempotente al
--      consultar, ver _shared/comisiones.js).
--   3. Correcciones de distribución — sin cambio de esquema: "reemplazada"
--      se deriva siempre de venta_distribuciones.estado (ya existente) vía
--      comisiones.distribucion_id — nunca se necesitó una columna nueva.
--   4. Proyectos históricos — reconstrucción de `comisiones_historicas`
--      con 3 tipos de registro (Brenda, 04/09/2026): "Solo referencia",
--      "Histórico económicamente reconstruido", "Obligación histórica
--      pendiente". Se DROPea y recrea (no ALTERa) porque:
--        a) es una tabla nueva de esta misma sesión (migración 0029),
--        b) está confirmada vacía en Preview (0 filas, verificado antes de
--           esta migración) y nunca tuvo datos reales,
--        c) ningún otro código ni FK depende de su forma anterior,
--      así que reconstruirla es mucho menos riesgoso que ALTERar el CHECK
--      de una tabla con datos o con máquina de estados en uso (`comisiones`,
--      `ventas`) — mismo criterio de "elegir la alternativa de menor
--      riesgo" ya aplicado y confirmado por Brenda en la migración 0029.
--
-- cliente/proyecto/producto/mercado/moneda/precio del proyecto histórico
-- YA están disponibles vía la venta vinculada (ventas.cliente_id/producto/
-- mercado/moneda/precio_pactado) — no se duplican acá. Esta tabla guarda
-- lo que es específicamente HISTÓRICO: quién cobró qué, cuánto se sabe con
-- certeza, y (excepcionalmente) una obligación pendiente confirmada.

DROP TABLE comisiones_historicas;

CREATE TABLE comisiones_historicas (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  -- 'solo_referencia': no hay reconstrucción económica completa, es solo
  --   un registro de que el proyecto existió.
  -- 'reconstruido': se cargaron importes que YA ocurrieron (ya pagados).
  -- 'obligacion_pendiente': existe una deuda real confirmada, todavía sin
  --   pagar — EXCEPCIONAL, admin-only, exige confirmación explícita
  --   (ver CHECK más abajo y la validación adicional en el endpoint).
  tipo_registro TEXT NOT NULL CHECK (tipo_registro IN ('solo_referencia', 'reconstruido', 'obligacion_pendiente')),
  beneficiario_email TEXT,
  concepto TEXT CHECK (concepto IS NULL OR concepto IN ('comercial', 'supervision', 'desarrollo', 'realizacion', 'produccion')),
  distribucion_conocida TEXT,
  pagos_recibidos INTEGER,
  importe_pagado INTEGER,
  monto_empresa INTEGER,
  moneda TEXT CHECK (moneda IS NULL OR moneda IN ('CLP', 'ARS')),
  estado_final TEXT,
  observaciones TEXT,
  nivel_certeza TEXT CHECK (nivel_certeza IS NULL OR nivel_certeza IN ('alta', 'media', 'baja')),
  fecha_exacta TEXT,
  fecha_aproximada TEXT,
  evidencia TEXT,
  fuente TEXT NOT NULL,
  declarado_por TEXT NOT NULL,
  -- Exclusivo de 'obligacion_pendiente': confirmación administrativa
  -- explícita — nunca se infiere, nunca se activa por defecto.
  confirmado_por_admin INTEGER NOT NULL DEFAULT 0 CHECK (confirmado_por_admin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (fecha_exacta IS NOT NULL OR fecha_aproximada IS NOT NULL),
  CHECK (
    tipo_registro != 'obligacion_pendiente'
    OR (confirmado_por_admin = 1 AND beneficiario_email IS NOT NULL AND importe_pagado IS NOT NULL AND moneda IS NOT NULL)
  )
);
CREATE INDEX idx_comisiones_historicas_venta ON comisiones_historicas(venta_id);
