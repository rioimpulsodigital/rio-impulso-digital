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
import { procesarPagoAcreditadoParaComisiones, generarComisionesLandingSiCorresponde, retenerComisionesPorDisputa } from './comisiones.js';

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
  if (componente.materiales_estado !== 'completos') {
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
// cumplirse). También es el momento en que se generan las comisiones de
// producción y desarrollo de ESTE componente, si es Landing y hay alguien
// asignado con plan vigente (RIO-115) — nunca antes de la aprobación
// oficial, y nunca para un componente Ficha.
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

  await generarComisionesLandingSiCorresponde(db, requestId, {
    ventaId, componente, producto: venta.producto, mercado: venta.mercado, moneda: venta.moneda,
  });

  let gate = null;
  if (componente.tipo === 'ficha') {
    gate = await evaluateLandingGate(db, requestId, ventaId, actorEmail);
  }

  await recomputeProyectoEstado(db, requestId, ventaId, actorEmail);
  return { gate };
}

// Informa la recepción de materiales de un componente (RIO-113
// corrección, Brenda sección 4: "el vendedor recibió archivos" es un
// dato reportado, nunca una confirmación oficial). Solo puede llamarse
// desde 'pendiente' — no reemplaza ni adelanta la confirmación
// administrativa de `marcarMaterialesCompletos`, y NO reevalúa el gate
// de Landing (informado ≠ completo, igual criterio que los pagos).
export async function marcarMaterialesInformados(db, requestId, { ventaId, componenteId, actorEmail }) {
  const { componentes } = await loadVentaFull(db, requestId, ventaId);
  const componente = componentes.find((c) => c.id === componenteId);
  if (!componente) throw new ProyectoError('componente_no_encontrado', 'Componente no encontrado.');
  if (componente.materiales_estado !== 'pendiente') {
    throw new ProyectoError('materiales_ya_reportados', 'Los materiales de este componente ya fueron informados o confirmados como completos.');
  }

  await execute(db, requestId, "UPDATE componentes SET materiales_estado = 'informados' WHERE id = ?", [componenteId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'componente', entidadId: componenteId,
    estadoAnterior: 'materiales:pendiente', estadoNuevo: 'materiales:informados', usuarioEmail: actorEmail,
    motivoNota: 'El vendedor informó la recepción de materiales — pendiente de confirmación oficial de administración.',
    proximaAccion: 'Confirmar si los materiales alcanzan para producción', responsableProximaAccion: null,
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

  await execute(
    db, requestId,
    'INSERT INTO pagos_informados (id, pago_esperado_id, monto_informado, informado_por, comprobante_nota) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), pagoId, montoInformado, actorEmail, comprobanteNota || null]
  );
  await execute(db, requestId, "UPDATE pagos_esperados SET estado = 'informado' WHERE id = ?", [pagoId]);
  await logEvento(db, requestId, {
    ventaId, entidad: 'pago', entidadId: pagoId,
    estadoAnterior: pago.estado, estadoNuevo: 'informado', usuarioEmail: actorEmail,
    proximaAccion: 'Verificar acreditación bancaria', responsableProximaAccion: null,
  });
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

  let gate = null;
  if (pago.tipo === 'saldo') {
    gate = await evaluateLandingGate(db, requestId, ventaId, actorEmail);
  }
  return { gate };
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
