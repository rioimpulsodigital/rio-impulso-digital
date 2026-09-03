-- RIO-119 (quinto bloque, 04/09/2026): política de liberación confirmada
-- por Brenda para proyectos personalizados — cada cuota tiene su propio
-- plazo de resguardo (10 días corridos desde la ACREDITACIÓN
-- administrativa, nunca desde informado/comprobante/promesa), y una
-- participación se habilita solo cuando esa cuota está acreditada + 10
-- días cumplidos + hito validado + sin incidencia abierta + distribución
-- confirmada. Además: adelantos genéricos sobre comisiones personales
-- (capacidad configurable, nunca por nombre propio) y calendario 10/25 ya
-- existente (calcularFechaProgramada) reutilizado sin duplicar lógica.
--
-- Todas las columnas nuevas son ALTER TABLE ADD COLUMN sin CHECK sobre una
-- columna YA existente — mismo criterio que toda migración anterior.

-- Capacidad configurable para recibir un adelanto — nunca hardcodeada por
-- nombre propio (Brenda: "no lo programes por nombre propio").
ALTER TABLE asignaciones_rol ADD COLUMN can_receive_commission_advance INTEGER NOT NULL DEFAULT 0 CHECK (can_receive_commission_advance IN (0, 1));

-- Validación administrativa del hito/avance asociado a una cuota —
-- deliberadamente un único flag por cuota (no una tabla de hitos por
-- componente): Brenda no detalló una estructura fina de hitos múltiples
-- por cuota, así que se modela la condición mínima verificable que pidió
-- ("el hito... fue validado oficialmente por Administración"), documentado
-- como simplificación en el informe de cierre de este bloque.
ALTER TABLE pagos_esperados ADD COLUMN hito_validado INTEGER NOT NULL DEFAULT 0 CHECK (hito_validado IN (0, 1));
ALTER TABLE pagos_esperados ADD COLUMN hito_validado_por TEXT;
ALTER TABLE pagos_esperados ADD COLUMN hito_validado_at TEXT;
ALTER TABLE pagos_esperados ADD COLUMN hito_nota TEXT;

-- Liberación por cuota — UNA fila por cada par (comisión, cuota) de un
-- proyecto personalizado, creada al activar la distribución
-- (generarComisionesDesdeDistribucion). TABLA SEPARADA de `comisiones`
-- (mismo criterio ya aplicado a comisiones_historicas en la migración
-- 0029): `comisiones.estado` de un proyecto personalizado permanece
-- SIEMPRE en 'calculada_provisional' — la fila de comisiones es la
-- DEFINICIÓN (quién, qué %, snapshot), nunca la que transiciona. Todo el
-- estado real de habilitación/programación/pago vive acá, por cuota —
-- evita reconstruir el CHECK de `comisiones.estado` (SQLite no permite
-- ALTERar un CHECK existente sin reconstruir la tabla) y aísla por
-- completo esta lógica nueva de la máquina de estados de catálogo ya
-- probada.
CREATE TABLE comision_liberaciones (
  id TEXT PRIMARY KEY,
  comision_id TEXT NOT NULL REFERENCES comisiones(id),
  pago_id TEXT NOT NULL REFERENCES pagos_esperados(id),
  monto_liberable INTEGER NOT NULL,
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  fecha_acreditacion TEXT,
  fecha_cumplimiento_resguardo TEXT,
  estado TEXT NOT NULL DEFAULT 'retenida' CHECK (estado IN ('retenida', 'habilitada', 'programada', 'pagada')),
  motivo_retencion TEXT,
  fecha_habilitacion TEXT,
  fecha_programada_original TEXT,
  fecha_programada_efectiva TEXT,
  fecha_pago_real TEXT,
  motivo_reprogramacion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (comision_id, pago_id)
);
CREATE INDEX idx_comision_liberaciones_comision ON comision_liberaciones(comision_id);
CREATE INDEX idx_comision_liberaciones_pago ON comision_liberaciones(pago_id);

-- Adelantos de comisiones — genéricos, nunca por nombre propio. Un
-- adelanto reduce el saldo disponible de UNA comisión personal específica
-- — nunca toca `proyecto_finanzas_empresa` ni otras comisiones (RiO nunca
-- se modela como beneficiario de un adelanto). `idempotency_key` UNIQUE
-- evita duplicados por doble clic/reintento/falla de red — mismo criterio
-- que `ventas.idempotency_key`. `autoautorizado` queda explícito cuando
-- quien autoriza es el mismo beneficiario.
CREATE TABLE comision_adelantos (
  id TEXT PRIMARY KEY,
  comision_id TEXT NOT NULL REFERENCES comisiones(id),
  beneficiario_email TEXT NOT NULL,
  monto INTEGER NOT NULL CHECK (monto > 0),
  moneda TEXT NOT NULL CHECK (moneda IN ('CLP', 'ARS')),
  medio_pago TEXT,
  comprobante_referencia TEXT,
  motivo TEXT NOT NULL,
  autorizado_por TEXT NOT NULL,
  autoautorizado INTEGER NOT NULL DEFAULT 0 CHECK (autoautorizado IN (0, 1)),
  saldo_anterior INTEGER NOT NULL,
  saldo_posterior INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comision_adelantos_comision ON comision_adelantos(comision_id);
