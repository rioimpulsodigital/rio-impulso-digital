-- RIO-119 (cuarto bloque, 03/09/2026): convertir la distribución confirmada
-- de un proyecto personalizado en participaciones económicas y comisiones
-- reales — idempotente, auditable, separada de empresa, provisional hasta
-- que los costos se cierren, y sin habilitar pago automático hasta que
-- Brenda confirme la política de liberación y el plazo de resguardo.
--
-- Todas las columnas nuevas son ALTER TABLE ADD COLUMN sin CHECK sobre una
-- columna YA existente (SQLite no permite ALTERar un CHECK existente sin
-- reconstruir la tabla — ver 0024/0025/0027) — mismo criterio que toda
-- migración anterior de esta sesión.

-- `comisiones`: trazabilidad hacia la distribución/participación de origen
-- (NULL para comisiones de catálogo, que siguen resolviéndose vía
-- planes_comision) y si el monto todavía es una estimación (costos sin
-- cerrar) o ya es definitivo.
ALTER TABLE comisiones ADD COLUMN distribucion_id TEXT REFERENCES venta_distribuciones(id);
ALTER TABLE comisiones ADD COLUMN participacion_id TEXT REFERENCES venta_participaciones(id);
ALTER TABLE comisiones ADD COLUMN es_estimacion INTEGER NOT NULL DEFAULT 0 CHECK (es_estimacion IN (0, 1));
CREATE INDEX idx_comisiones_distribucion ON comisiones(distribucion_id);

-- `venta_distribuciones`: configuración propia del proyecto — nunca se
-- asume el mismo punto de partida que Ficha/Landing (plazo de resguardo
-- fijo de 10 días desde el primer pago). Todo NULL/0 por defecto: mientras
-- Brenda no confirme la política, ninguna comisión de un proyecto
-- personalizado puede avanzar de 'calculada_provisional' (ver el gate
-- agregado a evaluateComisionGate en _shared/comisiones.js).
ALTER TABLE venta_distribuciones ADD COLUMN politica_liberacion TEXT CHECK (politica_liberacion IS NULL OR politica_liberacion IN ('pago_total', 'proporcional_por_pago', 'por_hito'));
ALTER TABLE venta_distribuciones ADD COLUMN requiere_hito_validado INTEGER NOT NULL DEFAULT 0 CHECK (requiere_hito_validado IN (0, 1));
ALTER TABLE venta_distribuciones ADD COLUMN plazo_resguardo_activo INTEGER NOT NULL DEFAULT 0 CHECK (plazo_resguardo_activo IN (0, 1));
ALTER TABLE venta_distribuciones ADD COLUMN plazo_resguardo_dias INTEGER;
ALTER TABLE venta_distribuciones ADD COLUMN plazo_resguardo_tipo_dias TEXT CHECK (plazo_resguardo_tipo_dias IS NULL OR plazo_resguardo_tipo_dias IN ('habiles', 'corridos'));
ALTER TABLE venta_distribuciones ADD COLUMN plazo_resguardo_evento_inicio TEXT CHECK (plazo_resguardo_evento_inicio IS NULL OR plazo_resguardo_evento_inicio IN ('activacion', 'primer_pago', 'pago_total', 'hito_aprobado'));
ALTER TABLE venta_distribuciones ADD COLUMN plazo_resguardo_alcance TEXT CHECK (plazo_resguardo_alcance IS NULL OR plazo_resguardo_alcance IN ('proyecto_completo', 'por_pago_o_hito'));
-- Declaración administrativa explícita de que ya se cargaron todos los
-- costos directos del proyecto — no hay una lista fija de costos
-- esperados por proyecto a medida, así que "cerrado" es una decisión de
-- Administración, nunca inferida. Mientras sea 0, todo importe calculado
-- (comisiones y finanzas de empresa) se marca es_estimacion=1.
ALTER TABLE venta_distribuciones ADD COLUMN costos_cerrados INTEGER NOT NULL DEFAULT 0 CHECK (costos_cerrados IN (0, 1));
ALTER TABLE venta_distribuciones ADD COLUMN costos_cerrados_por TEXT;
ALTER TABLE venta_distribuciones ADD COLUMN costos_cerrados_at TEXT;

-- Participación de empresa — deliberadamente NUNCA una fila en
-- `comisiones` (RiO no se modela como una persona ficticia). Append-only:
-- cada recálculo (al activar, y después de cada corrección de costos)
-- inserta una fila nueva — nunca se sobrescribe, el historial completo de
-- estimación → definitivo queda visible. `fondos_obtenidos` es lo
-- efectivamente acreditado a la fecha del cálculo (informativo, no mueve
-- estado); "fondos todavía estimados" es monto_empresa - fondos_obtenidos.
CREATE TABLE proyecto_finanzas_empresa (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  distribucion_id TEXT NOT NULL REFERENCES venta_distribuciones(id),
  monto_bruto INTEGER NOT NULL,
  costos_directos INTEGER NOT NULL,
  utilidad_neta INTEGER NOT NULL,
  porcentaje_empresa INTEGER NOT NULL,
  monto_empresa INTEGER NOT NULL,
  fondos_obtenidos INTEGER NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  es_estimacion INTEGER NOT NULL CHECK (es_estimacion IN (0, 1)),
  motivo TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_finanzas_empresa_venta ON proyecto_finanzas_empresa(venta_id);

-- Comisiones históricas (proyectos importados de antes de RiO usar este
-- sistema) — TABLA SEPARADA, nunca una reconstrucción de `comisiones`.
--
-- Alternativas auditadas antes de decidir (Brenda, 03/09/2026: "auditá las
-- alternativas y elegí la menos riesgosa"):
--   1. Agregar 'historica_pagada_antes_incorporacion' al CHECK de
--      comisiones.estado — descartado: SQLite no permite ALTERar un CHECK
--      existente sin reconstruir la tabla completa (crear nueva, copiar
--      filas, borrar vieja, renombrar — mismo problema ya documentado en
--      0024/0025/0027), un riesgo real sobre una tabla con máquina de
--      estados compleja y ya probada exhaustivamente (evaluateComisionGate,
--      procesarPagoAcreditadoParaComisiones, marcarComisionPagada), para un
--      caso que estructuralmente NUNCA debe pasar por esa máquina.
--   2. Agregar una columna `es_historica` a `comisiones` sin tocar el
--      CHECK — descartado: no evita el riesgo real, que es que el código
--      existente (reevaluarComisionesDeVenta, el calendario 10/25, las
--      liquidaciones) sigue viendo la fila y necesitaría un `WHERE
--      es_historica = 0` agregado a cada consulta — un guard fácil de
--      olvidar en código futuro, no una garantía estructural.
--   3. Tabla separada (ELEGIDA): una fila acá es estructuralmente invisible
--      para toda la máquina de estados de comisiones — ningún código
--      existente la consulta, así que nunca puede entrar al calendario
--      10/25, nunca dispara notificaciones, nunca se recalcula con planes
--      vigentes, nunca se confunde con una comisión real. Cero riesgo
--      sobre el pipeline ya probado, y no requiere reconstruir ninguna
--      tabla de SQLite.
CREATE TABLE comisiones_historicas (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  beneficiario_email TEXT NOT NULL,
  concepto TEXT NOT NULL CHECK (concepto IN ('comercial', 'supervision', 'desarrollo', 'realizacion', 'produccion')),
  importe_pagado INTEGER NOT NULL CHECK (importe_pagado >= 0),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  fecha_exacta TEXT,
  fecha_aproximada TEXT,
  evidencia TEXT,
  estado TEXT NOT NULL DEFAULT 'historica_pagada_antes_incorporacion' CHECK (estado = 'historica_pagada_antes_incorporacion'),
  fuente TEXT NOT NULL,
  declarado_por TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (fecha_exacta IS NOT NULL OR fecha_aproximada IS NOT NULL)
);
CREATE INDEX idx_comisiones_historicas_venta ON comisiones_historicas(venta_id);
