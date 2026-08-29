// Cálculo y máquina de 9 estados de la comisión — RIO-114.
//
// Independiente de la máquina de estados del proyecto (RIO-113): que una
// comisión esté pagada no dice nada sobre el avance de producción, y
// viceversa (RIO-97 v2 sección 8).
//
// Principio central de esta tarea (Brenda, 28/08/2026, al corregir el
// alcance de RIO-113): el porcentaje de comisión NUNCA es un valor fijo en
// el código — es un dato editable en `planes_comision`, resuelto por tipo
// de comisión y producto vendido. Si no hay una tasa vigente para una
// combinación, la comisión igual se genera (queda visible y auditable, "una
// venta puede generar 0% de comisión" no es lo mismo que "no existe"), pero
// con `porcentaje_snapshot`/`monto_comision` en NULL — nunca se inventa un
// número.
//
// Deliberadamente NO implementado acá (fuera de alcance de RIO-114, ya
// documentado en las tareas correspondientes): comisión de producción (no
// existe todavía ninguna tabla de asignación de asistente a componente —
// RIO-97 v2 la documenta como "hoy sin nadie asignado"); feriados de
// Chile/Argentina en el cálculo de la fecha programada (solo se ajusta
// fin de semana al día hábil anterior); agrupación en liquidaciones y
// transferencias (RIO-115, "Calendario y liquidaciones").

import { query, execute } from './db.js';
import { logEvento } from './historial.js';

export class ComisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComisionError';
    this.code = code;
  }
}

// Plazo de resguardo — confirmado por Brenda, RIO-97 v2 sección 9: 10 días
// corridos desde la acreditación del primer pago. Configuración, no un
// valor disperso en el código — vive acá, en un solo lugar.
const PLAZO_RESGUARDO_DIAS = 10;

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function parseAllowedMarkets(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function resolverPlanVigente(db, requestId, { tipo, producto }) {
  const rows = await query(
    db, requestId,
    `SELECT * FROM planes_comision
     WHERE tipo = ? AND producto = ?
       AND (valid_until IS NULL OR valid_until > datetime('now'))
       AND valid_from <= datetime('now')
     ORDER BY valid_from DESC LIMIT 1`,
    [tipo, producto]
  );
  return rows[0] || null;
}

async function utilidadNetaComponente(db, requestId, componente) {
  const costos = await query(db, requestId, 'SELECT monto FROM costos_directos WHERE componente_id = ?', [componente.id]);
  const totalCostos = costos.reduce((sum, c) => sum + c.monto, 0);
  return componente.precio_atribuido - totalCostos;
}

async function crearComision(db, requestId, { tipo, ventaId, componenteId, beneficiarioEmail, producto, moneda, montoBase }) {
  const plan = await resolverPlanVigente(db, requestId, { tipo, producto });
  const id = crypto.randomUUID();
  const montoComision = plan ? Math.round((montoBase * plan.porcentaje) / 100) : null;
  await execute(
    db, requestId,
    `INSERT INTO comisiones (id, tipo, venta_id, componente_id, beneficiario_email, plan_id, porcentaje_snapshot, base_snapshot, monto_base, moneda, monto_comision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tipo, ventaId, componenteId || null, beneficiarioEmail, plan ? plan.id : null, plan ? plan.porcentaje : null, plan ? plan.base : null, montoBase, moneda, montoComision]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'comision', entidadId: id, estadoNuevo: 'calculada_provisional', usuarioEmail: beneficiarioEmail,
    motivoNota: plan ? null : 'Sin tasa de comisión configurada todavía para este producto — queda pendiente de carga administrativa en planes_comision.',
  });
  return id;
}

// Genera la comisión comercial (siempre, 1 por venta) y una comisión de
// supervisión por cada supervisor activo cuyo mercado autorizado incluya el
// de esta venta (RIO-97 v2 sección 6: "comisión_supervision si el mercado
// de la venta tiene supervisor asignado"). NO genera comisión de
// producción — ver nota de alcance arriba del archivo.
export async function generarComisionesParaVenta(db, requestId, { ventaId, vendedorEmail, mercado, producto, moneda, componentes }) {
  let utilidadNetaVenta = 0;
  for (const c of componentes) {
    utilidadNetaVenta += await utilidadNetaComponente(db, requestId, c);
  }

  const ids = [];
  ids.push(await crearComision(db, requestId, {
    tipo: 'comercial', ventaId, componenteId: null, beneficiarioEmail: vendedorEmail, producto, moneda, montoBase: utilidadNetaVenta,
  }));

  const supervisoresActivos = await query(
    db, requestId,
    `SELECT u.email, a.allowed_markets FROM usuarios u JOIN asignaciones_rol a ON a.usuario_id = u.id
     WHERE a.role = 'supervisor' AND a.user_status = 'activo'
       AND (a.valid_until IS NULL OR a.valid_until > datetime('now')) AND a.valid_from <= datetime('now')`,
    []
  );
  for (const s of supervisoresActivos) {
    if (!parseAllowedMarkets(s.allowed_markets).includes(mercado)) continue;
    ids.push(await crearComision(db, requestId, {
      tipo: 'supervision', ventaId, componenteId: null, beneficiarioEmail: s.email, producto, moneda, montoBase: utilidadNetaVenta,
    }));
  }

  return ids;
}

// Fecha programada de pago (RIO-97 v2 sección 10), calculada a partir de la
// fecha de HABILITACIÓN (nunca de la fecha de registro de la venta — una
// comisión no puede programarse antes de estar habilitada). Ajusta fin de
// semana al día hábil anterior; feriados de Chile/Argentina NO están
// contemplados todavía (fuera de alcance — no hay calendario de feriados
// como fuente de datos en este proyecto).
export function calcularFechaProgramada(fechaHabilitacionSql) {
  const d = new Date(fechaHabilitacionSql.replace(' ', 'T') + 'Z');
  const dia = d.getUTCDate();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();

  let targetDay, targetMonth;
  if (dia >= 26) {
    targetDay = 25; targetMonth = month + 1;
  } else if (dia <= 10) {
    targetDay = 25; targetMonth = month;
  } else {
    targetDay = 10; targetMonth = month + 1;
  }

  const programada = new Date(Date.UTC(year, targetMonth, targetDay));
  const dow = programada.getUTCDay(); // 0 = domingo, 6 = sábado.
  if (dow === 0) programada.setUTCDate(programada.getUTCDate() - 2);
  else if (dow === 6) programada.setUTCDate(programada.getUTCDate() - 1);
  return programada.toISOString().slice(0, 10);
}

// Evalúa las 3 condiciones independientes que habilitan una comisión
// (plazo de resguardo cumplido, pago total acreditado, venta sin disputa
// abierta — RIO-97 v2 sección 8, estados 3/4/5 → 6). Mismo patrón que el
// gate de 3 condiciones de Landing en RIO-113: siempre informa qué falta,
// nunca asume un orden entre las condiciones. Si las tres se cumplen,
// habilita y programa en el mismo paso (programar es automático, nunca
// requiere una acción manual aparte de habilitar).
export async function evaluateComisionGate(db, requestId, comisionId, actorEmail) {
  const rows = await query(db, requestId, 'SELECT * FROM comisiones WHERE id = ?', [comisionId]);
  const comision = rows[0];
  if (!comision) throw new ComisionError('comision_no_encontrada', 'Comisión no encontrada.');
  if (comision.estado !== 'calculada_provisional') {
    return { habilitada: true, faltantes: [] }; // ya pasó este punto — nada que reevaluar.
  }

  const faltantes = [];

  if (!comision.fecha_inicio_plazo) {
    faltantes.push('plazo_resguardo_iniciado');
  } else {
    const inicio = new Date(comision.fecha_inicio_plazo.replace(' ', 'T') + 'Z');
    const limite = new Date(inicio.getTime() + PLAZO_RESGUARDO_DIAS * 24 * 60 * 60 * 1000);
    const cumplido = Date.now() >= limite.getTime();
    if (!cumplido) {
      faltantes.push('plazo_resguardo_cumplido');
    } else if (!comision.fecha_cumplimiento_plazo) {
      await execute(db, requestId, 'UPDATE comisiones SET fecha_cumplimiento_plazo = ? WHERE id = ?', [limite.toISOString().replace('T', ' ').slice(0, 19), comisionId]);
    }
  }

  if (!comision.fecha_pago_total_acreditado) faltantes.push('pago_total_acreditado');

  const disputasAbiertas = await query(db, requestId, "SELECT id FROM incidencias WHERE venta_id = ? AND estado = 'abierta'", [comision.venta_id]);
  if (disputasAbiertas.length > 0) faltantes.push('venta_sin_disputa');

  if (faltantes.length > 0) {
    return { habilitada: false, faltantes };
  }

  const fechaHabilitacion = nowSql();
  await execute(db, requestId, "UPDATE comisiones SET estado = 'habilitada', fecha_habilitacion = ? WHERE id = ?", [fechaHabilitacion, comisionId]);
  await logEvento(db, requestId, {
    ventaId: comision.venta_id, entidad: 'comision', entidadId: comisionId,
    estadoAnterior: 'calculada_provisional', estadoNuevo: 'habilitada', usuarioEmail: actorEmail || 'sistema',
    motivoNota: 'Las 3 condiciones (plazo de resguardo, pago total acreditado, sin disputa) se cumplieron a la vez.',
  });

  const fechaProgramada = calcularFechaProgramada(fechaHabilitacion);
  await execute(
    db, requestId,
    "UPDATE comisiones SET estado = 'programada', fecha_programada_original = ?, fecha_programada_efectiva = ? WHERE id = ?",
    [fechaProgramada, fechaProgramada, comisionId]
  );
  await logEvento(db, requestId, {
    ventaId: comision.venta_id, entidad: 'comision', entidadId: comisionId,
    estadoAnterior: 'habilitada', estadoNuevo: 'programada', usuarioEmail: actorEmail || 'sistema',
    motivoNota: `Fecha programada calculada automáticamente: ${fechaProgramada}.`,
  });

  return { habilitada: true, faltantes: [] };
}

// Reevalúa todas las comisiones de una venta — se llama después de
// cualquier evento que pueda cambiar una de las 3 condiciones (un pago se
// acredita, una incidencia se resuelve).
export async function reevaluarComisionesDeVenta(db, requestId, ventaId, actorEmail) {
  const comisiones = await query(db, requestId, 'SELECT id FROM comisiones WHERE venta_id = ?', [ventaId]);
  for (const c of comisiones) {
    await evaluateComisionGate(db, requestId, c.id, actorEmail);
  }
}

// Se llama desde proyectos.js justo después de que un pago quedó
// 'acreditado' (nunca antes) — registra las dos fechas que dependen de
// pagos (inicio del plazo de resguardo, pago total acreditado) y reevalúa
// el gate de cada comisión de la venta.
export async function procesarPagoAcreditadoParaComisiones(db, requestId, { ventaId, pagoTipo, actorEmail }) {
  const pagos = await query(db, requestId, 'SELECT * FROM pagos_esperados WHERE venta_id = ?', [ventaId]);
  const esPrimerPago = pagos.length === 1 ? pagoTipo === 'total' : pagoTipo === 'inicial';
  const todosAcreditados = pagos.length > 0 && pagos.every((p) => p.estado === 'acreditado');

  if (esPrimerPago || todosAcreditados) {
    const comisiones = await query(db, requestId, 'SELECT id, fecha_inicio_plazo, fecha_pago_total_acreditado FROM comisiones WHERE venta_id = ?', [ventaId]);
    for (const c of comisiones) {
      if (esPrimerPago && !c.fecha_inicio_plazo) {
        await execute(db, requestId, 'UPDATE comisiones SET fecha_inicio_plazo = ? WHERE id = ?', [nowSql(), c.id]);
      }
      if (todosAcreditados && !c.fecha_pago_total_acreditado) {
        await execute(db, requestId, 'UPDATE comisiones SET fecha_pago_total_acreditado = ? WHERE id = ?', [nowSql(), c.id]);
      }
    }
  }

  await reevaluarComisionesDeVenta(db, requestId, ventaId, actorEmail);
}

// Marca una comisión como pagada — exclusivo de administración (se valida
// en el endpoint). Solo desde 'programada': "habilitación separada de
// programación y pago" (criterio de aceptación de RIO-114) — no se puede
// pagar algo que nunca llegó a programarse.
export async function marcarComisionPagada(db, requestId, { comisionId, actorEmail, fechaPagoReal }) {
  const rows = await query(db, requestId, 'SELECT * FROM comisiones WHERE id = ?', [comisionId]);
  const comision = rows[0];
  if (!comision) throw new ComisionError('comision_no_encontrada', 'Comisión no encontrada.');
  if (comision.estado !== 'programada') {
    throw new ComisionError('transicion_invalida', `No se puede marcar como pagada desde el estado ${comision.estado}.`);
  }
  const fecha = fechaPagoReal || nowSql();
  await execute(db, requestId, "UPDATE comisiones SET estado = 'pagada', fecha_pago_real = ? WHERE id = ?", [fecha, comisionId]);
  await logEvento(db, requestId, {
    ventaId: comision.venta_id, entidad: 'comision', entidadId: comisionId,
    estadoAnterior: 'programada', estadoNuevo: 'pagada', usuarioEmail: actorEmail,
  });
}

// Alta de un costo directo de un componente (ej. dominio propio de una
// Landing Premium) — exclusivo de administración (autorizado_por, validado
// en el endpoint). Se descuenta de la utilidad neta de ESE componente, pero
// solo afecta comisiones generadas DESPUÉS de este registro — nunca
// recalcula hacia atrás una comisión ya generada (mismo principio de
// snapshot inmutable que el resto del sistema).
export async function registrarCostoDirecto(db, requestId, { componenteId, tipo, monto, moneda, autorizadoPor, nota }) {
  const id = crypto.randomUUID();
  await execute(
    db, requestId,
    'INSERT INTO costos_directos (id, componente_id, tipo, monto, moneda, autorizado_por, nota) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, componenteId, tipo, monto, moneda, autorizadoPor, nota || null]
  );
  return id;
}
