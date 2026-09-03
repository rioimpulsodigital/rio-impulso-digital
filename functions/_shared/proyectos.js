// Flujo secuencial del proyecto y pagos — RIO-113.
//
// Regla central (Brenda, 27/08/2026 — RIO-97 v2 sección 7 reescrita): en un
// pack, Ficha y Landing NUNCA se producen en paralelo. Landing solo puede
// empezar cuando se cumplen, a la vez, las tres condiciones:
//   1. El componente Ficha está 'aprobada'.
//   2. El segundo 50% (pago tipo 'saldo') está 'acreditado'.
//   3. Los materiales del componente Landing están 'completos'.
// RIO-112 ya deja el componente Landing de un pack en 'bloqueada' desde su
// creación — este módulo es el que lo desbloquea cuando corresponde, y el
// que informa exactamente cuál condición falta cuando no corresponde
// todavía (criterio de aceptación 2 de RIO-113).
//
// No mezcla estados del proyecto con estados de comisión — no hay ninguna
// comisión en este archivo ni en todo RIO-113 (RIO-114 es aparte).

import { query, execute } from './db.js';
import { logEvento } from './historial.js';
import { procesarPagoAcreditadoParaComisiones, generarComisionesRealizacionSiCorresponde, retenerComisionesPorDisputa, reevaluarLiberacionesDeVenta, retenerLiberacionesPorDisputa } from './comisiones.js';

export class ProyectoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProyectoError';
    this.code = code; // código estable para el frontend — nunca se inventa un texto libre.
  }
}

// Carga venta + proyecto + componentes + pagos esperados de una venta.
// Devuelve null si la venta no existe.
export async function loadVentaFull(db, requestId, ventaId) {
  const ventas = await query(db, requestId, 'SELECT * FROM ventas WHERE id = ?', [ventaId]);
  const venta = ventas[0];
  if (!venta) return null;
  const proyectos = await query(db, requestId, 'SELECT * FROM proyectos WHERE venta_id = ?', [venta.id]);
  const proyecto = proyectos[0] || null;
  const componentes = proyecto
    ? await query(db, requestId, 'SELECT * FROM componentes WHERE proyecto_id = ? ORDER BY tipo', [proyecto.id])
    : [];
  const pagos = await query(db, requestId, 'SELECT * FROM pagos_esperados WHERE venta_id = ? ORDER BY tipo', [venta.id]);
  return { venta, proyecto, componentes, pagos };
}

// El pago "relevante" para que un componente pueda empezar a producirse:
// individual -> el único pago (tipo 'total'); Ficha de un pack -> el pago
// inicial (50%). El componente Landing de un pack no usa esta función para
// habilitar su propio inicio de producción — su condición de pago (saldo
// acreditado) ya forma parte del gate de las 3 condiciones, evaluado antes
// de que Landing pueda siquiera salir de 'bloqueada'.
function relevantPagoForStart(pagos, tipo) {
  if (pagos.length === 1) return pagos[0]; // individual.
  if (tipo === 'ficha') return pagos.find((p) => p.tipo === 'inicial') || null;
  return null; // landing de un pack: no aplica acá, lo cubre el gate.
}

// Evalúa las 3 condiciones para desbloquear el componente Landing de un
// pack. Si las tres se cumplen y Landing sigue 'bloqueada', lo pasa a
// 'pendiente' y registra el evento. Devuelve SIEMPRE el detalle de qué
// falta (aunque no haya nada para desbloquear) — los endpoints lo usan
// para informar la condición exacta que bloquea el avance.
export async function evaluateLandingGate(db, requestId, ventaId, actorEmail) {
  const { proyecto, componentes, pagos } = await loadVentaFull(db, requestId, ventaId);
  const landing = componentes.find((c) => c.tipo === 'landing');
  if (!landing) return { aplica: false, faltantes: [], desbloqueada: false };

  const ficha = componentes.find((c) => c.tipo === 'ficha');
  const fichaAprobada = ficha ? ficha.estado_actual === 'aprobada' : false;
  const saldo = pagos.find((p) => p.tipo === 'saldo');
  const saldoAcreditado = saldo ? saldo.estado === 'acreditado' : false;
  const materialesCompletos = landing.materiales_estado === 'completos';

  const faltantes = [];
  if (!fichaAprobada) faltantes.push('ficha_aprobada');
  if (!saldoAcreditado) faltantes.push('segundo_pago_acreditado');
  if (!materialesCompletos) faltantes.push('materiales_landing_completos');

  let desbloqueada = false;
  if (faltantes.length === 0 && landing.estado_actual === 'bloqueada') {
    await execute(db, requestId, "UPDATE componentes SET estado_actual = 'pendiente' WHERE id = ?", [landing.id]);
    await logEvento(db, requestId, {
      ventaId, entidad: 'componente', entidadId: landing.id,
      estadoAnterior: 'bloqueada', estadoNuevo: 'pendiente', usuarioEmail: actorEmail,
      motivoNota: 'Las 3 condiciones para iniciar Landing quedaron cumplidas a la vez.',
      proximaAccion: 'Iniciar producción de Landing', responsableProximaAccion: null,
    });
    desbloqueada = true;
  }

  return { aplica: true, faltantes, desbloqueada, proyectoId: proyecto?.id };
}

// Transición pendiente -> en_produccion. Rechaza con ProyectoError si el
// componente está 'bloqueada' (informa qué falta), si sus materiales no
// están completos, o si el pago correspondiente no está acreditado.
export async function iniciarProduccion(db, requestId, { ventaId, componenteId, actorEmail }) {
  const { componentes, pagos } = await loadVentaFull(db, requestId, ventaId);
  const componente = componentes.find((c) => c.id === componenteId);
  if (!componente) throw new ProyectoError('componente_no_encontrado', 'Componente no encontrado.');

  if (componente.estado_actual === 'bloqueada') {
    const gate = await evaluateLandingGate(db, requestId, ventaId, actorEmail);
    throw new ProyectoError('landing_bloqueada', JSON.stringify({ faltantes: gate.faltantes }));
  }
  if (componente.estado_actual !== 'pendiente') {
    throw new ProyectoError('transicion_invalida', `No se puede iniciar producción desde el estado ${componente.estado_actual}.`);
  }
  // RIO-119 (proyectos personalizados, 02/09/2026): una fase de un
  // proyecto a medida no tiene el mismo concepto de "materiales" que
  // Ficha/Landing (fotos/logo que entrega el cliente) — nunca se le exige
  // ese gate, que fue diseñado para ese caso específico.
  if (componente.tipo !== 'personalizado' && componente.materiales_estado !== 'completos') {
    throw new ProyectoError('materiales_incompletos', 'Los materiales de este componente todavía no están completos.');
  }
  const pagoRelevante = relevantPagoForStart(pagos, componente.tipo);
  if (pagoRelevante && pagoRelevante.estado !== 'acreditado') {
    throw new ProyectoError('pago_no_acreditado', 'El pago correspondiente todavía no está acreditado.');
  }

  await execute(db, requestId, "UPDATE componentes SET estado_actual = 'en_produccion' WHERE id = ?", [componenteId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: componente.estado_actual, estadoNuevo: 'en_produccion', usuarioEmail: actorEmail,
    proximaAccion: 'Entregar primera versión', responsableProximaAccion: actorEmail,
  });
}

// Transición en_produccion -> entregada.
export async function marcarEntregada(db, requestId, { ventaId, componenteId, actorEmail }) {
  const { componentes } = await loadVentaFull(db, requestId, ventaId);
  const componente = componentes.find((c) => c.id === componenteId);
  if (!componente) throw new ProyectoError('componente_no_encontrado', 'Componente no encontrado.');
  if (componente.estado_actual !== 'en_produccion') {
    throw new ProyectoError('transicion_invalida', `No se puede entregar desde el estado ${componente.estado_actual}.`);
  }

  await execute(db, requestId, "UPDATE componentes SET estado_actual = 'entregada' WHERE id = ?", [componenteId]);
  const notaSegundoPago = componente.tipo === 'ficha'
    ? 'Ficha presentada al cliente — corresponde solicitar el segundo 50% si la venta es un pack.'
    : null;
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: 'en_produccion', estadoNuevo: 'entregada', usuarioEmail: actorEmail,
    motivoNota: notaSegundoPago,
    proximaAccion: 'Esperar aprobación del cliente (o corregir si pide cambios)', responsableProximaAccion: actorEmail,
  });
}

// Transición entregada -> aprobada. Si es el componente Ficha de un pack,
// reevalúa el gate de Landing (una de las 3 condiciones acaba de
// cumplirse). También es el momento en que se genera la comisión de
// producción de ESTE componente (Ficha o Landing), y la de desarrollo si
// además es Landing (RIO-115: "en el caso de la ficha... no hay
// desarrollo, pero alguien tiene que hacerla, y quien la haga tiene que
// tener su %") — nunca antes de la aprobación oficial.
export async function aprobarComponente(db, requestId, { ventaId, componenteId, actorEmail }) {
  const { venta, componentes } = await loadVentaFull(db, requestId, ventaId);
  const componente = componentes.find((c) => c.id === componenteId);
  if (!componente) throw new ProyectoError('componente_no_encontrado', 'Componente no encontrado.');
  if (componente.estado_actual !== 'entregada') {
    throw new ProyectoError('transicion_invalida', `No se puede aprobar desde el estado ${componente.estado_actual}.`);
  }

  await execute(db, requestId, "UPDATE componentes SET estado_actual = 'aprobada' WHERE id = ?", [componenteId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: 'entregada', estadoNuevo: 'aprobada', usuarioEmail: actorEmail,
  });

  await generarComisionesRealizacionSiCorresponde(db, requestId, {
    ventaId, componente, producto: venta.producto, mercado: venta.mercado, moneda: venta.moneda,
  });

  let gate = null;
  if (componente.tipo === 'ficha') {
    gate = await evaluateLandingGate(db, requestId, ventaId, actorEmail);
  }

  await recomputeProyectoEstado(db, requestId, ventaId, actorEmail);
  return { gate };
}

// Informa la recepción de materiales de un componente — RIO-118
// (corrección funcional, 01/09/2026): el cliente entrega al ejecutivo,
// que reenvía por correo a venta@rioimpulsodigital.com — el Portal NUNCA
// almacena archivos, solo registra el HECHO de la entrega. Cada llamada
// crea una entrega NUEVA E INMUTABLE, numerada secuencialmente por
// componente — "Materiales completos" en el componente NUNCA cierra este
// registro ni oculta la posibilidad de informar de nuevo (reemplaza el
// límite de RIO-117, que exigía un reseteo administrativo para volver a
// informar — ya no hace falta: siempre está abierto).
//
// Si el componente YA estaba 'completos' cuando llega esta entrega, es
// "material adicional" — se deja constancia con su propio tipo de evento
// (`material_adicional_informado`), pero NUNCA se toca automáticamente
// materiales_estado, ni el gate, ni ningún plazo — esa decisión queda
// exclusivamente para administración (ver revisarEntregaMateriales).
export async function marcarMaterialesInformados(db, requestId, { ventaId, componenteId, actorEmail, elementos, descripcion, cantidadArchivosAprox, observaciones }) {
  const { componentes } = await loadVentaFull(db, requestId, ventaId);
  const componente = componentes.find((c) => c.id === componenteId);
  if (!componente) throw new ProyectoError('componente_no_encontrado', 'Componente no encontrado.');

  const existentes = await query(db, requestId, 'SELECT COUNT(*) AS n FROM materiales_informados_detalle WHERE componente_id = ?', [componenteId]);
  const numeroEntrega = (existentes[0]?.n || 0) + 1;
  const esAdicionalTrasCompletos = componente.materiales_estado === 'completos';

  const detalleId = crypto.randomUUID();
  await execute(
    db, requestId,
    `INSERT INTO materiales_informados_detalle
       (id, componente_id, informado_por, elementos_json, observaciones, numero_entrega, descripcion, cantidad_archivos_aprox)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [detalleId, componenteId, actorEmail, JSON.stringify(elementos || []), observaciones || null, numeroEntrega, descripcion || '', Number.isInteger(cantidadArchivosAprox) ? cantidadArchivosAprox : null]
  );

  if (esAdicionalTrasCompletos) {
    await logEvento(db, requestId, {
      ventaId, entidad: 'componente', entidadId: componenteId,
      estadoNuevo: 'material_adicional_informado', usuarioEmail: actorEmail,
      motivoNota: `Entrega adicional N.º ${numeroEntrega} — el componente ya estaba marcado como completos. Administración decide si se incorpora, reemplaza, requiere corrección, queda fuera de alcance o afecta el plazo.`,
      proximaAccion: 'Revisar la entrega adicional', responsableProximaAccion: null,
    });
    return { detalleId, numeroEntrega, esAdicionalTrasCompletos: true };
  }

  if (componente.materiales_estado === 'pendiente') {
    await execute(db, requestId, "UPDATE componentes SET materiales_estado = 'informados' WHERE id = ?", [componenteId]);
  }
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: `materiales:${componente.materiales_estado}`, estadoNuevo: 'materiales:informados', usuarioEmail: actorEmail,
    motivoNota: `Entrega N.º ${numeroEntrega} informada — pendiente de revisión administrativa.`,
    proximaAccion: 'Revisar la entrega y, si corresponde, confirmar materiales completos', responsableProximaAccion: null,
  });
  return { detalleId, numeroEntrega, esAdicionalTrasCompletos: false };
}

// Revisión administrativa de UNA entrega puntual (RIO-118, corrección
// funcional) — exclusivo de administración (se valida en el endpoint).
// Nunca modifica materiales_estado del componente, el gate, ni ningún
// plazo: eso queda para marcarMaterialesCompletos (acción aparte,
// deliberadamente separada) o para lo que administración decida hacer
// manualmente. `motivo` es obligatorio para 'requiere_material_adicional'
// y 'descartada_con_motivo' — se valida en el endpoint.
export async function revisarEntregaMateriales(db, requestId, { ventaId, componenteId, entregaId, actorEmail, resultado, motivo }) {
  const entregas = await query(db, requestId, 'SELECT * FROM materiales_informados_detalle WHERE id = ? AND componente_id = ?', [entregaId, componenteId]);
  const entrega = entregas[0];
  if (!entrega) throw new ProyectoError('entrega_no_encontrada', 'Entrega de materiales no encontrada.');

  await execute(
    db, requestId,
    "UPDATE materiales_informados_detalle SET estado_revision = ?, revisado_por = ?, revisado_en = datetime('now'), motivo_revision = ? WHERE id = ?",
    [resultado, actorEmail, motivo || null, entregaId]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: `entrega:${entrega.estado_revision}`, estadoNuevo: `entrega:${resultado}`, usuarioEmail: actorEmail,
    motivoNota: motivo || null,
  });
}

// Confirma oficialmente los materiales de un componente como completos
// (exclusivo de administración — se valida en el endpoint). Puede
// llamarse desde 'pendiente' o 'informados': la confirmación oficial no
// depende de que el vendedor haya informado antes (Brenda no lo exige
// como paso obligatorio, solo separa ambos conceptos). Si es Landing,
// reevalúa el gate.
export async function marcarMaterialesCompletos(db, requestId, { ventaId, componenteId, actorEmail }) {
  const { componentes } = await loadVentaFull(db, requestId, ventaId);
  const componente = componentes.find((c) => c.id === componenteId);
  if (!componente) throw new ProyectoError('componente_no_encontrado', 'Componente no encontrado.');
  if (componente.materiales_estado === 'completos') {
    throw new ProyectoError('ya_completos', 'Los materiales de este componente ya estaban marcados como completos.');
  }

  await execute(
    db, requestId,
    'INSERT INTO materiales_confirmaciones (id, componente_id, admin_email, resultado) VALUES (?, ?, ?, ?)',
    [crypto.randomUUID(), componenteId, actorEmail, 'completos']
  );
  await execute(db, requestId, "UPDATE componentes SET materiales_estado = 'completos' WHERE id = ?", [componenteId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: `materiales:${componente.materiales_estado}`, estadoNuevo: 'materiales:completos', usuarioEmail: actorEmail,
    motivoNota: 'Confirmación oficial de administración: los materiales alcanzan para producción.',
  });

  let gate = null;
  if (componente.tipo === 'landing') {
    gate = await evaluateLandingGate(db, requestId, ventaId, actorEmail);
  }
  return { gate };
}

// Edita los campos de gestión de una fase (RIO-119, tercer bloque item 5,
// 03/09/2026) — orden, responsable OPERATIVO, fechas prevista/real. NUNCA
// toca `estado_actual`: ese sigue viajando exclusivamente por las
// transiciones ya gateadas (iniciar-produccion/entregar/aprobar en
// proyectos.js) — editar-fase es metadata de gestión, no un atajo que
// bypasee esos gates. Deliberadamente separado de
// `venta_participaciones` (quién cobra un %): una persona puede ser
// responsable operativo de una fase sin recibir participación económica,
// y viceversa — administración confirma cada uno por separado, nunca se
// infiere uno del otro.
export async function editarFase(db, requestId, { ventaId, componenteId, actorEmail, orden, responsableOperativoEmail, fechaPrevista, fechaReal }) {
  const { componentes } = await loadVentaFull(db, requestId, ventaId);
  const componente = componentes.find((c) => c.id === componenteId);
  if (!componente) throw new ProyectoError('componente_no_encontrado', 'Componente no encontrado.');

  await execute(
    db, requestId,
    'UPDATE componentes SET orden = ?, responsable_operativo_email = ?, fecha_prevista = ?, fecha_real = ? WHERE id = ?',
    [
      orden !== undefined ? orden : componente.orden,
      responsableOperativoEmail !== undefined ? responsableOperativoEmail : componente.responsable_operativo_email,
      fechaPrevista !== undefined ? fechaPrevista : componente.fecha_prevista,
      fechaReal !== undefined ? fechaReal : componente.fecha_real,
      componenteId,
    ]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: null, estadoNuevo: 'fase_editada', usuarioEmail: actorEmail,
    motivoNota: 'Edición de fase (responsable operativo/fechas/orden).',
  });
  return {};
}

// Rollup del estado del proyecto a partir de sus componentes — nunca se
// guarda a mano en paralelo, se recalcula desde los componentes reales
// cada vez (sin segunda fuente de verdad).
export async function recomputeProyectoEstado(db, requestId, ventaId, actorEmail) {
  const { proyecto, componentes } = await loadVentaFull(db, requestId, ventaId);
  if (!proyecto || componentes.length === 0) return;
  const todasAprobadas = componentes.every((c) => c.estado_actual === 'aprobada');
  const nuevoEstado = todasAprobadas ? 'completado' : 'en_produccion';
  if (proyecto.estado_actual !== nuevoEstado) {
    await execute(db, requestId, 'UPDATE proyectos SET estado_actual = ? WHERE id = ?', [nuevoEstado, proyecto.id]);
    await logEvento(db, requestId, {
      ventaId, entidad: 'proyecto', entidadId: proyecto.id,
      estadoAnterior: proyecto.estado_actual, estadoNuevo: nuevoEstado, usuarioEmail: actorEmail,
    });
  }
}

// Informar un pago (ejecutivo/admin/supervisor) — nunca lo acredita.
export async function informarPago(db, requestId, { ventaId, pagoId, montoInformado, comprobanteNota, actorEmail }) {
  const { pagos } = await loadVentaFull(db, requestId, ventaId);
  const pago = pagos.find((p) => p.id === pagoId);
  if (!pago) throw new ProyectoError('pago_no_encontrado', 'Pago esperado no encontrado.');
  if (pago.estado === 'acreditado') {
    throw new ProyectoError('ya_acreditado', 'Este pago ya está acreditado.');
  }

  const pagoInformadoId = crypto.randomUUID();
  await execute(
    db, requestId,
    'INSERT INTO pagos_informados (id, pago_esperado_id, monto_informado, informado_por, comprobante_nota) VALUES (?, ?, ?, ?, ?)',
    [pagoInformadoId, pagoId, montoInformado, actorEmail, comprobanteNota || null]
  );
  await execute(db, requestId, "UPDATE pagos_esperados SET estado = 'informado' WHERE id = ?", [pagoId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'pago', entidadId: pagoId,
    estadoAnterior: pago.estado, estadoNuevo: 'informado', usuarioEmail: actorEmail,
    proximaAccion: 'Verificar acreditación bancaria', responsableProximaAccion: null,
  });
  return { pagoInformadoId };
}

// Acreditar un pago (admin únicamente — se valida en el endpoint, esta
// función asume que el rol ya fue verificado). Si es el saldo de un pack,
// reevalúa el gate de Landing.
export async function acreditarPago(db, requestId, { ventaId, pagoId, montoAcreditado, nota, actorEmail }) {
  const { pagos } = await loadVentaFull(db, requestId, ventaId);
  const pago = pagos.find((p) => p.id === pagoId);
  if (!pago) throw new ProyectoError('pago_no_encontrado', 'Pago esperado no encontrado.');
  if (pago.estado === 'acreditado') {
    throw new ProyectoError('ya_acreditado', 'Este pago ya está acreditado.');
  }
  if (pago.estado !== 'informado') {
    throw new ProyectoError('sin_informar', 'Este pago todavía no fue informado — no se puede acreditar directamente.');
  }
  const informados = await query(db, requestId, 'SELECT * FROM pagos_informados WHERE pago_esperado_id = ? ORDER BY created_at DESC LIMIT 1', [pagoId]);
  const pagoInformado = informados[0];
  if (!pagoInformado) throw new ProyectoError('sin_informar', 'No hay un pago informado para acreditar.');

  await execute(
    db, requestId,
    'INSERT INTO acreditaciones (id, pago_informado_id, monto_acreditado, verificado_por, nota) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), pagoInformado.id, montoAcreditado, actorEmail, nota || null]
  );
  await execute(db, requestId, "UPDATE pagos_esperados SET estado = 'acreditado' WHERE id = ?", [pagoId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'pago', entidadId: pagoId,
    estadoAnterior: 'informado', estadoNuevo: 'acreditado', usuarioEmail: actorEmail,
  });

  // RIO-114: un pago acreditado puede iniciar el plazo de resguardo de la
  // comisión (si es el primer pago) y/o marcar "pago total acreditado" (si
  // era el último pendiente) — nunca bloquea ni revierte la acreditación
  // del pago si algo de esto fallara, es una consecuencia contable, no una
  // condición del pago en sí.
  await procesarPagoAcreditadoParaComisiones(db, requestId, { ventaId, pagoTipo: pago.tipo, actorEmail });
  // RIO-119 (quinto bloque, 04/09/2026): en un proyecto personalizado, esta
  // cuota puede ser la que le faltaba a una o más liberaciones — nunca
  // bloquea ni revierte la acreditación si algo de esto fallara.
  await reevaluarLiberacionesDeVenta(db, requestId, ventaId, actorEmail);

  let gate = null;
  if (pago.tipo === 'saldo') {
    gate = await evaluateLandingGate(db, requestId, ventaId, actorEmail);
  }
  return { gate };
}

// Rechaza un pago informado (RIO-116, admin únicamente — verificado en el
// endpoint) — vuelve a 'pendiente' para que el vendedor pueda informar de
// nuevo (y subir un comprobante nuevo, que queda como una versión más,
// nunca reemplaza en silencio la anterior). Nunca borra el pago informado
// ni el comprobante ya subido — quedan en el historial, solo se abre la
// puerta a una corrección.
export async function rechazarPago(db, requestId, { ventaId, pagoId, motivo, actorEmail }) {
  const { pagos } = await loadVentaFull(db, requestId, ventaId);
  const pago = pagos.find((p) => p.id === pagoId);
  if (!pago) throw new ProyectoError('pago_no_encontrado', 'Pago esperado no encontrado.');
  if (pago.estado === 'acreditado') {
    throw new ProyectoError('ya_acreditado', 'Este pago ya está acreditado — no se puede rechazar.');
  }
  if (pago.estado !== 'informado') {
    throw new ProyectoError('sin_informar', 'Este pago todavía no fue informado — no hay nada que rechazar.');
  }

  const informados = await query(db, requestId, 'SELECT id FROM pagos_informados WHERE pago_esperado_id = ? ORDER BY created_at DESC LIMIT 1', [pagoId]);
  const pagoInformadoId = informados[0]?.id || null;

  await execute(db, requestId, "UPDATE pagos_esperados SET estado = 'pendiente' WHERE id = ?", [pagoId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'pago', entidadId: pagoId,
    estadoAnterior: 'informado', estadoNuevo: 'pendiente', usuarioEmail: actorEmail,
    motivoNota: motivo, proximaAccion: 'Informar el pago nuevamente con un comprobante válido', responsableProximaAccion: null,
  });
  return { pagoInformadoId };
}

// Antecedente u observación libre sobre una venta (RIO-113 corrección,
// Brenda sección 3: "agregar antecedentes u observaciones" es una
// capacidad explícita del vendedor). Nunca cambia ningún estado oficial
// ni de pago — es únicamente un dato reportado más en el historial
// append-only, igual que "el cliente manifestó aprobación" en la
// sección 4 de su corrección.
export async function agregarAntecedente(db, requestId, { ventaId, nota, actorEmail }) {
  await logEvento(db, requestId, {
    ventaId, entidad: 'venta', entidadId: ventaId,
    estadoNuevo: 'antecedente', usuarioEmail: actorEmail, motivoNota: nota,
  });
}

// Cancelación, devolución, reclamo o disputa — nunca borra nada, solo
// agrega una incidencia y su evento correspondiente.
export async function registrarIncidencia(db, requestId, { ventaId, tipo, motivo, actorEmail }) {
  const id = crypto.randomUUID();
  await execute(
    db, requestId,
    'INSERT INTO incidencias (id, venta_id, tipo, motivo, registrado_por) VALUES (?, ?, ?, ?, ?)',
    [id, ventaId, tipo, motivo, actorEmail]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'incidencia', entidadId: id,
    estadoNuevo: `${tipo}:abierta`, usuarioEmail: actorEmail, motivoNota: motivo,
  });

  // RIO-114: una disputa abierta retiene (nunca borra) cualquier comisión
  // de esta venta que ya estuviera habilitada o programada — "venta firme
  // y sin disputa" deja de cumplirse antes del pago.
  await retenerComisionesPorDisputa(db, requestId, { ventaId, actorEmail, motivo: `Incidencia registrada: ${tipo} — ${motivo}` });
  // RIO-119 (quinto bloque, 04/09/2026): mismo criterio para las
  // liberaciones por cuota de un proyecto personalizado.
  await retenerLiberacionesPorDisputa(db, requestId, { ventaId, actorEmail, motivo: `Incidencia registrada: ${tipo} — ${motivo}` });

  return id;
}

// Resuelve una incidencia — necesario para que "venta firme y sin disputa"
// (condición de habilitación de comisión, RIO-114) pueda dejar de estar
// bloqueada si la disputa se resuelve. Exclusivo de administración (se
// valida en el endpoint, igual que registrarIncidencia).
export async function resolverIncidencia(db, requestId, { incidenciaId, actorEmail }) {
  const rows = await query(db, requestId, 'SELECT * FROM incidencias WHERE id = ?', [incidenciaId]);
  const incidencia = rows[0];
  if (!incidencia) throw new ProyectoError('incidencia_no_encontrada', 'Incidencia no encontrada.');
  if (incidencia.estado === 'resuelta') {
    throw new ProyectoError('ya_resuelta', 'Esta incidencia ya estaba resuelta.');
  }

  await execute(db, requestId, "UPDATE incidencias SET estado = 'resuelta', resuelta_at = datetime('now') WHERE id = ?", [incidenciaId]);
  await logEvento(db, requestId, {
    ventaId: incidencia.venta_id, entidad: 'incidencia', entidadId: incidenciaId,
    estadoAnterior: `${incidencia.tipo}:abierta`, estadoNuevo: `${incidencia.tipo}:resuelta`, usuarioEmail: actorEmail,
  });
  return incidencia.venta_id;
}
