// Cálculo y máquina de estados de la comisión — RIO-114, corregido según
// las decisiones definitivas de Brenda del 28/08/2026 (segunda corrección).
//
// Independiente de la máquina de estados del proyecto (RIO-113): que una
// comisión esté pagada no dice nada sobre el avance de producción, y
// viceversa (RIO-97 v2 sección 8).
//
// Principio central: el porcentaje NUNCA es un valor fijo en el código, y
// tampoco alcanza con una tabla de tasas por producto — se resuelve en dos
// pasos, igual que el modelo de identidad de RIO-111: una DEFINICIÓN de
// plan (`planes_comision`: tipo, porcentaje, base, productos y mercados
// alcanzados, estado) y una ASIGNACIÓN versionada de ese plan a una persona
// (`asignaciones_plan_comision`, mismo patrón que `asignaciones_rol`). Si
// una persona no tiene una asignación vigente de un plan que además
// alcance el producto y mercado de la venta, NO se genera esa comisión —
// nunca un número inventado ni una fila con 0% disfrazado de definitivo
// (Brenda: "la atribución como vendedor no genera comisión si no existe un
// plan comercial activo").
//
// Deliberadamente NO implementado acá (fuera de alcance de RIO-114, ya
// documentado en las tareas correspondientes): agrupación en liquidaciones
// y transferencias (RIO-115, "Calendario y liquidaciones").

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
// corridos desde la acreditación del primer pago.
const PLAZO_RESGUARDO_DIAS = 10;

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function utilidadNetaComponente(db, requestId, componente) {
  const costos = await query(db, requestId, 'SELECT monto FROM costos_directos WHERE componente_id = ?', [componente.id]);
  const totalCostos = costos.reduce((sum, c) => sum + c.monto, 0);
  return componente.precio_atribuido - totalCostos;
}

// Resuelve la asignación de plan VIGENTE de una persona para un tipo de
// comisión, solo si el plan además alcanza el producto y el mercado de
// esta venta (productos_alcanzados/mercados_alcanzados). Devuelve null si
// no hay asignación, si el plan está inactivo/vencido, o si no alcanza
// este producto o mercado — en cualquiera de esos casos, no corresponde
// generar la comisión (ver principio central arriba).
//
// IMPORTANTE (corrección RIO-115, 30/08/2026): una misma persona puede
// tener MÁS de una asignación vigente del mismo tipo a la vez, cada una
// alcanzando productos distintos — ej. Brenda tiene comercial 0% para
// Ficha/packs y comercial 40% para Landing individual, simultáneamente
// vigentes. Por eso acá se traen TODAS las asignaciones vigentes de ese
// tipo (sin LIMIT en la consulta) y el filtro por producto/mercado se
// aplica en código a cada una — quedarse con la primera fila antes de
// filtrar (como hacía la versión anterior) podía descartar por accidente
// la asignación que sí correspondía a este producto.
async function resolverAsignacionVigente(db, requestId, { usuarioEmail, tipo, producto, mercado }) {
  const rows = await query(
    db, requestId,
    `SELECT ap.id AS asignacion_id, pl.id AS plan_id, pl.porcentaje, pl.base, pl.productos_alcanzados, pl.mercados_alcanzados
     FROM usuarios u
     JOIN asignaciones_plan_comision ap ON ap.usuario_id = u.id
     JOIN planes_comision pl ON pl.id = ap.plan_id
     WHERE u.email = ? AND pl.tipo = ?
       AND (ap.valid_until IS NULL OR ap.valid_until > datetime('now')) AND ap.valid_from <= datetime('now')
       AND pl.estado = 'activo'
       AND (pl.valid_until IS NULL OR pl.valid_until > datetime('now')) AND pl.valid_from <= datetime('now')
     ORDER BY ap.valid_from DESC`,
    [usuarioEmail, tipo]
  );
  const coincide = rows.find((row) =>
    parseJsonArray(row.productos_alcanzados).includes(producto) && parseJsonArray(row.mercados_alcanzados).includes(mercado)
  );
  return coincide || null;
}

async function crearComisionSiCorresponde(db, requestId, { tipo, ventaId, componenteId, beneficiarioEmail, producto, mercado, moneda, montoBase }) {
  const asignacion = await resolverAsignacionVigente(db, requestId, { usuarioEmail: beneficiarioEmail, tipo, producto, mercado });
  if (!asignacion) return null;

  const id = crypto.randomUUID();
  const montoComision = Math.round((montoBase * asignacion.porcentaje) / 100);
  await execute(
    db, requestId,
    `INSERT INTO comisiones (id, tipo, venta_id, componente_id, beneficiario_email, plan_id, asignacion_plan_id, porcentaje_snapshot, base_snapshot, monto_base, moneda, monto_comision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tipo, ventaId, componenteId || null, beneficiarioEmail, asignacion.plan_id, asignacion.asignacion_id, asignacion.porcentaje, asignacion.base, montoBase, moneda, montoComision]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'comision', entidadId: id, estadoNuevo: 'calculada_provisional', usuarioEmail: beneficiarioEmail,
  });
  return id;
}

// Genera la comisión comercial (si el vendedor tiene un plan comercial
// vigente que alcance este producto/mercado) y una comisión de supervisión
// por cada supervisor activo cuyo mercado autorizado incluya el de esta
// venta Y tenga un plan de supervisión vigente que la alcance. Ninguna de
// las dos se genera "a la fuerza" — sin plan, no hay fila (ver principio
// central arriba del archivo).
export async function generarComisionesParaVenta(db, requestId, { ventaId, vendedorEmail, mercado, producto, moneda, componentes }) {
  let utilidadNetaVenta = 0;
  for (const c of componentes) {
    utilidadNetaVenta += await utilidadNetaComponente(db, requestId, c);
  }

  const ids = [];
  const comercialId = await crearComisionSiCorresponde(db, requestId, {
    tipo: 'comercial', ventaId, componenteId: null, beneficiarioEmail: vendedorEmail, producto, mercado, moneda, montoBase: utilidadNetaVenta,
  });
  if (comercialId) ids.push(comercialId);

  const supervisoresActivos = await query(
    db, requestId,
    `SELECT u.email, a.allowed_markets FROM usuarios u JOIN asignaciones_rol a ON a.usuario_id = u.id
     WHERE a.role = 'supervisor' AND a.user_status = 'activo'
       AND (a.valid_until IS NULL OR a.valid_until > datetime('now')) AND a.valid_from <= datetime('now')`,
    []
  );
  for (const s of supervisoresActivos) {
    if (!parseJsonArray(s.allowed_markets).includes(mercado)) continue;
    const id = await crearComisionSiCorresponde(db, requestId, {
      tipo: 'supervision', ventaId, componenteId: null, beneficiarioEmail: s.email, producto, mercado, moneda, montoBase: utilidadNetaVenta,
    });
    if (id) ids.push(id);
  }

  return ids;
}

// Distribución de participaciones de trabajo por componente — RIO-115
// (corrección, Brenda 30/08/2026, extendida 31/08/2026): 40% comercial +
// 10% supervisión + 10% producción + 20% desarrollo + 20% empresa para
// Landing; para Ficha, lo mismo MENOS desarrollo (Brenda: "en el caso de
// la ficha es lo mismo, no hay desarrollo, pero alguien tiene que
// hacerla, y quien la haga tiene que tener su % — los mismos que para la
// Landing") — así que Ficha reparte comercial 40 + supervisión 10 +
// producción 10, y el 40% restante (sin un rol de desarrollo que lo
// reclame) queda como remanente de empresa. Todos sobre la misma base
// (utilidad neta del componente) — nunca en cascada sobre el saldo de
// otra comisión. Comercial y supervisión ya se generan a nivel de venta
// (arriba, generarComisionesParaVenta) — acá solo se agregan producción
// (Ficha y Landing) y desarrollo (exclusivo de Landing, "no hay
// desarrollo" para Ficha). El 20%/40% de empresa NO se modela como fila:
// no es una comisión personal ni utilidad final confirmada (Brenda:
// "todavía debe cubrir los gastos generales") — es el remanente
// implícito, mismo criterio que ya regía cuando no había nadie asignado.
//
// Cada rol requiere sus propias 3 condiciones, igual que antes: (1) una
// asignación EXPRESA del componente a esa persona PARA ESE ROL en
// `asignaciones_produccion` (RIO-97 v2: "hoy sin nadie asignado" — nunca
// se inventa un beneficiario; la ausencia de un practicante no le asigna
// automáticamente el % a nadie más); (2) que esa persona esté activa; (3)
// un plan vigente de ese tipo que alcance este producto/mercado. Una
// misma persona puede tener ambos roles sobre el mismo componente Landing
// (ej. Brenda produce Y desarrolla) — cada uno genera su propia fila,
// nunca sumadas. Se llama al aprobar oficialmente el componente
// (proyectos.js) — nunca antes, y nunca retroactiva: si la asignación
// llega después de aprobado, no hay a qué "aprobar" de nuevo.
const ROLES_POR_TIPO_COMPONENTE = {
  ficha: ['produccion'],
  landing: ['produccion', 'desarrollo'],
};

async function usuarioActivo(db, requestId, email) {
  const rows = await query(
    db, requestId,
    `SELECT a.user_status FROM usuarios u JOIN asignaciones_rol a ON a.usuario_id = u.id
     WHERE u.email = ? AND (a.valid_until IS NULL OR a.valid_until > datetime('now')) AND a.valid_from <= datetime('now')
     ORDER BY a.valid_from DESC LIMIT 1`,
    [email]
  );
  return rows[0]?.user_status === 'activo';
}

async function generarComisionPorRolComponente(db, requestId, { rol, ventaId, componente, producto, mercado, moneda }) {
  const asignaciones = await query(db, requestId, 'SELECT usuario_email FROM asignaciones_produccion WHERE componente_id = ? AND rol = ?', [componente.id, rol]);
  const asignacion = asignaciones[0];
  if (!asignacion) return null; // sin asignación expresa para ESTE rol.

  if (!(await usuarioActivo(db, requestId, asignacion.usuario_email))) return null;

  const utilidad = await utilidadNetaComponente(db, requestId, componente);
  return crearComisionSiCorresponde(db, requestId, {
    tipo: rol, ventaId, componenteId: componente.id, beneficiarioEmail: asignacion.usuario_email,
    producto, mercado, moneda, montoBase: utilidad,
  });
}

export async function generarComisionesTrabajoComponenteSiCorresponde(db, requestId, { ventaId, componente, producto, mercado, moneda }) {
  const roles = ROLES_POR_TIPO_COMPONENTE[componente.tipo] || [];
  const ids = [];
  for (const rol of roles) {
    const id = await generarComisionPorRolComponente(db, requestId, { rol, ventaId, componente, producto, mercado, moneda });
    if (id) ids.push(id);
  }
  return ids;
}

// Costo directo de un medio de pago que aplica a TODA la venta, no a un
// componente puntual — se prorratea entre los componentes del pack con el
// mismo criterio proporcional que la distribución del precio del pack
// (RIO-97 v2 sección 6: redondea el primero, el segundo es el resto — la
// suma siempre da el monto total). En un producto individual, todo el
// monto va a su único componente.
export async function registrarCostoMedioPago(db, requestId, { ventaId, tipo, monto, moneda, autorizadoPor, nota }) {
  const proyectos = await query(db, requestId, 'SELECT id FROM proyectos WHERE venta_id = ?', [ventaId]);
  const proyecto = proyectos[0];
  if (!proyecto) throw new ComisionError('proyecto_no_encontrado', 'Proyecto no encontrado para esta venta.');
  const componentes = await query(db, requestId, 'SELECT id, precio_atribuido FROM componentes WHERE proyecto_id = ? ORDER BY tipo', [proyecto.id]);
  if (componentes.length === 0) throw new ComisionError('sin_componentes', 'Esta venta no tiene componentes.');

  let montos;
  if (componentes.length === 1) {
    montos = [monto];
  } else {
    const totalAtribuido = componentes.reduce((sum, c) => sum + c.precio_atribuido, 0);
    const primero = Math.round((monto * componentes[0].precio_atribuido) / totalAtribuido);
    montos = [primero, monto - primero];
  }

  const ids = [];
  for (let i = 0; i < componentes.length; i++) {
    ids.push(await registrarCostoDirecto(db, requestId, {
      componenteId: componentes[i].id, tipo, monto: montos[i], moneda, autorizadoPor, nota,
    }));
  }
  return ids;
}

// Fecha programada de pago (RIO-97 v2 sección 10), calculada a partir de
// la fecha de HABILITACIÓN. Ajusta hacia atrás, día por día, hasta caer en
// un día hábil real del mercado de la venta — cubre fin de semana Y
// feriados configurados en `dias_no_habiles` (varios días no hábiles
// consecutivos incluidos), sin feriados fijos en el código.
async function esDiaHabil(db, requestId, fechaIso, mercado) {
  const dow = new Date(fechaIso + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const feriados = await query(db, requestId, 'SELECT 1 AS x FROM dias_no_habiles WHERE mercado = ? AND fecha = ?', [mercado, fechaIso]);
  return feriados.length === 0;
}

export async function calcularFechaProgramada(db, requestId, fechaHabilitacionSql, mercado) {
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

  const candidato = new Date(Date.UTC(year, targetMonth, targetDay));
  // Retrocede día por día hasta encontrar un día hábil real — cubre fin de
  // semana y cualquier cantidad de feriados consecutivos configurados.
  let guard = 0;
  while (!(await esDiaHabil(db, requestId, candidato.toISOString().slice(0, 10), mercado))) {
    candidato.setUTCDate(candidato.getUTCDate() - 1);
    guard += 1;
    if (guard > 30) break; // defensivo — nunca debería hacer falta retroceder más de un mes.
  }
  return candidato.toISOString().slice(0, 10);
}

// Evalúa las 3 condiciones independientes que habilitan una comisión
// (plazo de resguardo cumplido, pago total acreditado, venta sin disputa
// abierta — RIO-97 v2 sección 8). Mismo patrón que el gate de 3
// condiciones de Landing en RIO-113: siempre informa qué falta, nunca
// asume un orden. Funciona tanto para una comisión recién calculada como
// para una RETENIDA (una disputa se resolvió y hay que reevaluar si ya
// puede volver a habilitarse) — en ambos casos, si las tres se cumplen,
// habilita y programa en el mismo paso.
export async function evaluateComisionGate(db, requestId, comisionId, actorEmail) {
  const rows = await query(db, requestId, 'SELECT * FROM comisiones WHERE id = ?', [comisionId]);
  const comision = rows[0];
  if (!comision) throw new ComisionError('comision_no_encontrada', 'Comisión no encontrada.');
  if (comision.estado !== 'calculada_provisional' && comision.estado !== 'retenida') {
    return { habilitada: true, faltantes: [] }; // 'habilitada'/'programada'/'pagada' — nada que reevaluar acá.
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

  const veniaRetenida = comision.estado === 'retenida';
  const fechaHabilitacion = nowSql();
  await execute(db, requestId, "UPDATE comisiones SET estado = 'habilitada', fecha_habilitacion = ? WHERE id = ?", [fechaHabilitacion, comisionId]);
  await logEvento(db, requestId, {
    ventaId: comision.venta_id, entidad: 'comision', entidadId: comisionId,
    estadoAnterior: comision.estado, estadoNuevo: 'habilitada', usuarioEmail: actorEmail || 'sistema',
    motivoNota: veniaRetenida
      ? 'La disputa que la retenía se resolvió — vuelve a habilitarse.'
      : 'Las 3 condiciones (plazo de resguardo, pago total acreditado, sin disputa) se cumplieron a la vez.',
  });

  const ventaRows = await query(db, requestId, 'SELECT mercado FROM ventas WHERE id = ?', [comision.venta_id]);
  const mercado = ventaRows[0]?.mercado;
  const fechaProgramada = await calcularFechaProgramada(db, requestId, fechaHabilitacion, mercado);

  if (veniaRetenida && comision.fecha_programada_original) {
    // No se sobrescribe la fecha original — solo la efectiva, con motivo.
    await execute(
      db, requestId,
      "UPDATE comisiones SET estado = 'programada', fecha_programada_efectiva = ?, motivo_retencion_o_reprogramacion = ? WHERE id = ?",
      [fechaProgramada, 'Reprogramada tras resolverse la disputa que la retuvo.', comisionId]
    );
  } else {
    await execute(
      db, requestId,
      "UPDATE comisiones SET estado = 'programada', fecha_programada_original = ?, fecha_programada_efectiva = ? WHERE id = ?",
      [fechaProgramada, fechaProgramada, comisionId]
    );
  }
  await logEvento(db, requestId, {
    ventaId: comision.venta_id, entidad: 'comision', entidadId: comisionId,
    estadoAnterior: 'habilitada', estadoNuevo: 'programada', usuarioEmail: actorEmail || 'sistema',
    motivoNota: `Fecha programada calculada automáticamente: ${fechaProgramada}.`,
  });

  return { habilitada: true, faltantes: [] };
}

// Retiene (nunca elimina) las comisiones ya habilitadas/programadas de una
// venta cuando se abre una disputa — Brenda, sección 6: "si una condición
// deja de cumplirse antes del pago, la comisión debe retenerse... nunca
// desaparecer". Una comisión ya PAGADA no se toca — es terminal.
export async function retenerComisionesPorDisputa(db, requestId, { ventaId, actorEmail, motivo }) {
  const comisiones = await query(db, requestId, "SELECT id, estado FROM comisiones WHERE venta_id = ? AND estado IN ('habilitada', 'programada')", [ventaId]);
  for (const c of comisiones) {
    await execute(db, requestId, "UPDATE comisiones SET estado = 'retenida', motivo_retencion_o_reprogramacion = ? WHERE id = ?", [motivo, c.id]);
    await logEvento(db, requestId, {
      ventaId, entidad: 'comision', entidadId: c.id,
      estadoAnterior: c.estado, estadoNuevo: 'retenida', usuarioEmail: actorEmail, motivoNota: motivo,
    });
  }
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
// 'acreditado' — registra las dos fechas que dependen de pagos (inicio del
// plazo de resguardo, pago total acreditado) y reevalúa el gate de cada
// comisión de la venta.
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
// programación y pago" — no se puede pagar algo que nunca llegó a
// programarse, ni algo retenido por una disputa sin resolver.
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
// en el endpoint). Se descuenta de la utilidad neta de ESE componente,
// pero solo afecta comisiones generadas DESPUÉS de este registro — nunca
// recalcula hacia atrás una comisión ya generada (snapshot inmutable).
export async function registrarCostoDirecto(db, requestId, { componenteId, tipo, monto, moneda, autorizadoPor, nota }) {
  const id = crypto.randomUUID();
  await execute(
    db, requestId,
    'INSERT INTO costos_directos (id, componente_id, tipo, monto, moneda, autorizado_por, nota) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, componenteId, tipo, monto, moneda, autorizadoPor, nota || null]
  );
  return id;
}
