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

// RIO-117 (corrección tras validación real, 01/09/2026): en Landing
// Premium ("personalizado"/"ficha_personalizado") RiO asume el costo real
// del dominio propio incluido — hasta que ese costo se registre (aunque
// sea con monto 0, cuando el cliente trae su propio dominio y RiO no
// asume nada — "costo 0 con motivo auditable"), la utilidad neta de ese
// componente es una ESTIMACIÓN, no un valor definitivo: no hay forma de
// saber si el costo real la va a reducir. Por eso ninguna comisión que
// dependa de esa utilidad puede quedar habilitada/programada/pagada
// mientras el costo siga sin confirmar — se queda en
// 'calculada_provisional' (nunca se inventa un valor de dominio).
// Nunca aplica a Ficha ni a Landing genérica (sin dominio propio incluido).
export async function costoDominioPendienteParaComision(db, requestId, comision) {
  const ventaRows = await query(db, requestId, 'SELECT producto FROM ventas WHERE id = ?', [comision.venta_id]);
  const producto = ventaRows[0]?.producto;
  if (producto !== 'personalizado' && producto !== 'ficha_personalizado') return false;

  let landingIds;
  if (comision.componente_id) {
    // Comisión de realización: solo bloquea si ESTE componente es la Landing.
    const compRows = await query(db, requestId, 'SELECT id, tipo FROM componentes WHERE id = ?', [comision.componente_id]);
    if (!compRows[0] || compRows[0].tipo !== 'landing') return false;
    landingIds = [compRows[0].id];
  } else {
    // Comisión comercial/supervisión: a nivel de venta — busca la Landing del proyecto.
    const proyectoRows = await query(db, requestId, 'SELECT id FROM proyectos WHERE venta_id = ?', [comision.venta_id]);
    if (!proyectoRows[0]) return false;
    const compRows = await query(db, requestId, "SELECT id FROM componentes WHERE proyecto_id = ? AND tipo = 'landing'", [proyectoRows[0].id]);
    landingIds = compRows.map((c) => c.id);
  }

  for (const id of landingIds) {
    const costoRows = await query(db, requestId, "SELECT id FROM costos_directos WHERE componente_id = ? AND tipo = 'dominio'", [id]);
    if (costoRows.length === 0) return true; // todavía sin confirmar, ni siquiera en 0.
  }
  return false;
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
// `contextoRealizacion` solo aplica cuando tipo = 'realizacion' — distingue
// cuál de los 3 escenarios del pool de 30% corresponde ('solo' |
// 'responsable_con_practicante' | 'practicante', RIO-115 consolidación
// 31/08/2026). Para el resto de los tipos se ignora (esos planes siempre
// tienen contexto_realizacion NULL, sin ambigüedad).
export async function resolverAsignacionVigente(db, requestId, { usuarioEmail, tipo, producto, mercado, contextoRealizacion }) {
  const rows = await query(
    db, requestId,
    `SELECT ap.id AS asignacion_id, pl.id AS plan_id, pl.porcentaje, pl.base, pl.productos_alcanzados, pl.mercados_alcanzados, pl.contexto_realizacion
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
    parseJsonArray(row.productos_alcanzados).includes(producto)
    && parseJsonArray(row.mercados_alcanzados).includes(mercado)
    && (!contextoRealizacion || row.contexto_realizacion === contextoRealizacion)
  );
  return coincide || null;
}

async function crearComisionSiCorresponde(db, requestId, { tipo, ventaId, componenteId, beneficiarioEmail, producto, mercado, moneda, montoBase, contextoRealizacion, rolRealizacion }) {
  const asignacion = await resolverAsignacionVigente(db, requestId, { usuarioEmail: beneficiarioEmail, tipo, producto, mercado, contextoRealizacion });
  if (!asignacion) return null;

  const id = crypto.randomUUID();
  const montoComision = Math.round((montoBase * asignacion.porcentaje) / 100);
  await execute(
    db, requestId,
    `INSERT INTO comisiones (id, tipo, rol_realizacion, venta_id, componente_id, beneficiario_email, plan_id, asignacion_plan_id, porcentaje_snapshot, base_snapshot, monto_base, moneda, monto_comision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tipo, rolRealizacion || null, ventaId, componenteId || null, beneficiarioEmail, asignacion.plan_id, asignacion.asignacion_id, asignacion.porcentaje, asignacion.base, montoBase, moneda, montoComision]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'comision', entidadId: id, estadoNuevo: 'calculada_provisional', usuarioEmail: beneficiarioEmail,
  });
  return id;
}

// Resuelve el equipo VIGENTE de un vendedor — se llama al REGISTRAR la
// venta (ventas/index.js) para dejar un snapshot inmutable en
// ventas.equipo_id (RIO-115 consolidación, 31/08/2026: "mercado no
// equivale a equipo"). Si la persona no está en ningún equipo, devuelve
// null — la venta queda sin equipo, y por lo tanto sin comisión de
// supervisión, en vez de inventar un supervisor "del mercado".
export async function resolverEquipoVigenteDeVendedor(db, requestId, usuarioEmail) {
  const rows = await query(
    db, requestId,
    `SELECT equipo_id FROM equipo_miembros
     WHERE usuario_email = ? AND (valid_until IS NULL OR valid_until > datetime('now')) AND valid_from <= datetime('now')
     ORDER BY valid_from DESC LIMIT 1`,
    [usuarioEmail]
  );
  return rows[0]?.equipo_id || null;
}

// Resuelve el supervisor VIGENTE de un equipo — nunca "todos los
// supervisores del mercado" (Brenda: "no pagar automáticamente a todos
// los supervisores de un mercado. Debe corresponder al supervisor
// asignado al equipo de la venta").
export async function resolverSupervisorVigenteDeEquipo(db, requestId, equipoId) {
  const rows = await query(
    db, requestId,
    `SELECT usuario_email FROM equipo_supervisores
     WHERE equipo_id = ? AND (valid_until IS NULL OR valid_until > datetime('now')) AND valid_from <= datetime('now')
     ORDER BY valid_from DESC LIMIT 1`,
    [equipoId]
  );
  return rows[0]?.usuario_email || null;
}

// Genera la comisión comercial (si el vendedor tiene un plan comercial
// vigente que alcance este producto/mercado) y la comisión de supervisión
// del supervisor VIGENTE del equipo snapshotteado en la venta (nunca de
// "todos los supervisores del mercado" — RIO-115 consolidación,
// 31/08/2026). Sin equipo snapshotteado, o sin supervisor vigente en ese
// equipo, o sin plan vigente de ese supervisor: no se genera comisión de
// supervisión — nunca se inventa (ver principio central arriba).
export async function generarComisionesParaVenta(db, requestId, { ventaId, vendedorEmail, mercado, producto, moneda, componentes, equipoId }) {
  let utilidadNetaVenta = 0;
  for (const c of componentes) {
    utilidadNetaVenta += await utilidadNetaComponente(db, requestId, c);
  }

  const ids = [];
  const comercialId = await crearComisionSiCorresponde(db, requestId, {
    tipo: 'comercial', ventaId, componenteId: null, beneficiarioEmail: vendedorEmail, producto, mercado, moneda, montoBase: utilidadNetaVenta,
  });
  if (comercialId) ids.push(comercialId);

  if (equipoId) {
    const supervisorEmail = await resolverSupervisorVigenteDeEquipo(db, requestId, equipoId);
    if (supervisorEmail) {
      const id = await crearComisionSiCorresponde(db, requestId, {
        tipo: 'supervision', ventaId, componenteId: null, beneficiarioEmail: supervisorEmail, producto, mercado, moneda, montoBase: utilidadNetaVenta,
      });
      if (id) ids.push(id);
    }
  }

  return ids;
}

// Realización — RIO-115 (consolidación, Brenda 31/08/2026), reemplaza la
// distribución anterior de producción(10%)+desarrollo(20%) como roles
// siempre independientes. Landing, Ficha y cada componente de un Pack
// reparten un único pool de 30% de "realización":
//   - Sin practicante: el responsable se lleva el 30% entero.
//   - Con practicante: responsable 20% + practicante 10% — el practicante
//     participa DENTRO del 30%, nunca por encima (nunca 30+10=40%).
// El 40% comercial y el 20% empresa completan el 100% junto al 10% de
// supervisión (ya generados a nivel de venta, arriba) — el empresa NO se
// modela como fila, es el remanente implícito, nunca una comisión
// personal (Brenda: "todavía debe cubrir los gastos generales e
// impuestos").
//
// Requiere, para cada persona, sus propias 3 condiciones: (1) una
// asignación EXPRESA del componente a esa persona PARA ESE ROL en
// `asignaciones_realizacion` (RIO-97 v2: "hoy sin nadie asignado" — nunca
// se inventa un beneficiario, y "no asignar porcentajes automáticamente a
// Brenda por ser administradora" — ni a nadie más); (2) que esté activa;
// (3) un plan de 'realizacion' vigente CON EL CONTEXTO correcto (solo /
// responsable_con_practicante / practicante) que alcance este
// producto/mercado — el contexto lo decide el código según si hay o no
// practicante asignado en este componente, nunca una persona por sí sola.
// Se llama al aprobar oficialmente el componente (proyectos.js) — nunca
// antes, y nunca retroactiva: si la asignación llega después de aprobado,
// no hay a qué "aprobar" de nuevo.
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

export async function generarComisionesRealizacionSiCorresponde(db, requestId, { ventaId, componente, producto, mercado, moneda }) {
  const asignaciones = await query(db, requestId, 'SELECT usuario_email, rol FROM asignaciones_realizacion WHERE componente_id = ?', [componente.id]);
  const responsable = asignaciones.find((a) => a.rol === 'responsable');
  const practicante = asignaciones.find((a) => a.rol === 'practicante');
  if (!responsable) return []; // sin responsable asignado, no se genera nada — nunca automático.

  const utilidad = await utilidadNetaComponente(db, requestId, componente);
  const ids = [];

  if (practicante) {
    if (await usuarioActivo(db, requestId, responsable.usuario_email)) {
      const id = await crearComisionSiCorresponde(db, requestId, {
        tipo: 'realizacion', rolRealizacion: 'responsable', contextoRealizacion: 'responsable_con_practicante',
        ventaId, componenteId: componente.id, beneficiarioEmail: responsable.usuario_email, producto, mercado, moneda, montoBase: utilidad,
      });
      if (id) ids.push(id);
    }
    if (await usuarioActivo(db, requestId, practicante.usuario_email)) {
      const id = await crearComisionSiCorresponde(db, requestId, {
        tipo: 'realizacion', rolRealizacion: 'practicante', contextoRealizacion: 'practicante',
        ventaId, componenteId: componente.id, beneficiarioEmail: practicante.usuario_email, producto, mercado, moneda, montoBase: utilidad,
      });
      if (id) ids.push(id);
    }
  } else if (await usuarioActivo(db, requestId, responsable.usuario_email)) {
    const id = await crearComisionSiCorresponde(db, requestId, {
      tipo: 'realizacion', rolRealizacion: 'responsable', contextoRealizacion: 'solo',
      ventaId, componenteId: componente.id, beneficiarioEmail: responsable.usuario_email, producto, mercado, moneda, montoBase: utilidad,
    });
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

  if (await costoDominioPendienteParaComision(db, requestId, comision)) faltantes.push('costo_dominio_confirmado');

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
