// Ledger multimoneda y liquidaciones agrupadas — RIO-115.
//
// Reutiliza por completo la máquina de comisiones de RIO-114
// (`marcarComisionPagada`, el calendario de `calcularFechaProgramada` y
// `dias_no_habiles`) — acá solo se agrega lo que faltaba: el registro de
// una conversión real de moneda (siempre ARS -> CLP, siempre operada a
// mano por Brenda vía Global66 — nunca una API) y la agrupación de varias
// comisiones de una misma persona en una única transferencia, de una o
// ambas monedas (RIO-97 v2 secciones 16/17).
//
// Regla sin excepción: la comisión en ARS permanece en ARS hasta el
// momento REAL del pago. La conversión ocurre una sola vez, con el tipo de
// cambio que entregó Global66 en ese momento — el sistema nunca recalcula
// ese valor por su cuenta, solo lo registra tal cual se lo informan.

import { query, execute } from './db.js';
import { logEvento } from './historial.js';
import { marcarComisionPagada, ComisionError } from './comisiones.js';

export class LiquidacionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiquidacionError';
    this.code = code;
  }
}

// Registra la conversión real de UNA comisión en ARS a CLP — siempre
// posterior al hecho (Brenda ya hizo la operación en Global66 desde su
// teléfono), nunca una estimación previa. Una comisión solo se convierte
// una vez (UNIQUE en la tabla) — volver a intentarlo es un error, no una
// corrección silenciosa.
export async function registrarConversion(db, requestId, {
  comisionId, montoOriginal, tipoCambioMostrado, costosODiferencias, montoConvertido, registradoPor, fechaConversion,
}) {
  const rows = await query(db, requestId, 'SELECT * FROM comisiones WHERE id = ?', [comisionId]);
  const comision = rows[0];
  if (!comision) throw new LiquidacionError('comision_no_encontrada', 'Comisión no encontrada.');
  if (comision.moneda !== 'ARS') {
    throw new LiquidacionError('conversion_no_aplica', 'Solo las comisiones en ARS necesitan conversión — esta ya está en CLP.');
  }

  const existente = await query(db, requestId, 'SELECT id FROM conversiones WHERE comision_id = ?', [comisionId]);
  if (existente[0]) {
    throw new LiquidacionError('ya_convertida', 'Esta comisión ya tiene una conversión registrada.');
  }

  const id = crypto.randomUUID();
  const fecha = fechaConversion || new Date().toISOString().replace('T', ' ').slice(0, 19);
  await execute(
    db, requestId,
    `INSERT INTO conversiones (id, comision_id, monto_original, moneda_origen, fecha_conversion, tipo_cambio_mostrado, costos_o_diferencias_informadas, monto_convertido, moneda_final, registrado_por)
     VALUES (?, ?, ?, 'ARS', ?, ?, ?, ?, 'CLP', ?)`,
    [id, comisionId, montoOriginal, fecha, tipoCambioMostrado, costosODiferencias || 0, montoConvertido, registradoPor]
  );
  await logEvento(db, requestId, {
    ventaId: null, entidad: 'conversion', entidadId: id, estadoNuevo: 'registrada', usuarioEmail: registradoPor,
    motivoNota: `Conversión Global66: ${montoOriginal} ARS -> ${montoConvertido} CLP (tipo de cambio ${tipoCambioMostrado}).`,
  });
  return id;
}

// Agrupa N comisiones de UNA MISMA persona beneficiaria en una única
// transferencia — puede incluir comisiones en CLP y en ARS a la vez,
// siempre que las ARS ya tengan su conversión registrada (nunca se suman
// monedas distintas sin una conversión documentada de por medio). El
// monto total declarado debe reconciliar exactamente con la suma de lo
// incluido — si no coincide, se rechaza antes de tocar nada. Al confirmar,
// marca cada comisión como pagada (reutiliza marcarComisionPagada de
// RIO-114) — nunca se le puede pagar la misma comisión dos veces (UNIQUE
// en transferencia_detalle.comision_id).
export async function registrarLiquidacion(db, requestId, {
  beneficiarioEmail, fecha, monedaFinal, comisionIds, montoTotalTransferido, comprobanteNota, actorEmail,
}) {
  if (!Array.isArray(comisionIds) || comisionIds.length === 0) {
    throw new LiquidacionError('sin_comisiones', 'Una liquidación necesita al menos una comisión.');
  }

  const comisiones = [];
  for (const comisionId of comisionIds) {
    const rows = await query(db, requestId, 'SELECT * FROM comisiones WHERE id = ?', [comisionId]);
    const comision = rows[0];
    if (!comision) throw new LiquidacionError('comision_no_encontrada', `Comisión ${comisionId} no encontrada.`);
    if (comision.beneficiario_email !== beneficiarioEmail) {
      throw new LiquidacionError('beneficiario_no_coincide', 'Todas las comisiones de una liquidación deben ser de la misma persona beneficiaria.');
    }
    if (comision.estado !== 'programada') {
      throw new LiquidacionError('transicion_invalida', `La comisión ${comisionId} no está programada (estado actual: ${comision.estado}) — no se puede liquidar.`);
    }
    const yaIncluida = await query(db, requestId, 'SELECT id FROM transferencia_detalle WHERE comision_id = ?', [comisionId]);
    if (yaIncluida[0]) {
      throw new LiquidacionError('ya_liquidada', `La comisión ${comisionId} ya forma parte de otra transferencia.`);
    }
    comisiones.push(comision);
  }

  const detalle = [];
  let sumaCalculada = 0;
  for (const comision of comisiones) {
    if (comision.moneda === monedaFinal) {
      detalle.push({ comisionId: comision.id, montoIncluido: comision.monto_comision, monedaOriginal: comision.moneda, conversionId: null });
      sumaCalculada += comision.monto_comision;
    } else {
      if (!(comision.moneda === 'ARS' && monedaFinal === 'CLP')) {
        throw new LiquidacionError('conversion_no_soportada', `No hay conversión definida de ${comision.moneda} a ${monedaFinal}.`);
      }
      const conversionRows = await query(db, requestId, 'SELECT * FROM conversiones WHERE comision_id = ?', [comision.id]);
      const conversion = conversionRows[0];
      if (!conversion) {
        throw new LiquidacionError('conversion_faltante', `La comisión ${comision.id} está en ${comision.moneda} y esta liquidación es en ${monedaFinal} — hace falta registrar su conversión primero.`);
      }
      detalle.push({ comisionId: comision.id, montoIncluido: conversion.monto_convertido, monedaOriginal: comision.moneda, conversionId: conversion.id });
      sumaCalculada += conversion.monto_convertido;
    }
  }

  if (sumaCalculada !== montoTotalTransferido) {
    throw new LiquidacionError('no_reconciliable', `El total declarado (${montoTotalTransferido}) no coincide con la suma de las comisiones incluidas (${sumaCalculada}).`);
  }

  const transferenciaId = crypto.randomUUID();
  await execute(
    db, requestId,
    'INSERT INTO transferencias_comision (id, beneficiario_email, fecha, moneda_final, monto_total_transferido, comprobante_nota, registrado_por) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [transferenciaId, beneficiarioEmail, fecha, monedaFinal, montoTotalTransferido, comprobanteNota || null, actorEmail]
  );

  for (const d of detalle) {
    await execute(
      db, requestId,
      'INSERT INTO transferencia_detalle (id, transferencia_id, comision_id, monto_incluido, moneda_original, conversion_id) VALUES (?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), transferenciaId, d.comisionId, d.montoIncluido, d.monedaOriginal, d.conversionId]
    );
    try {
      await marcarComisionPagada(db, requestId, { comisionId: d.comisionId, actorEmail, fechaPagoReal: fecha });
    } catch (e) {
      if (!(e instanceof ComisionError)) throw e;
      // No debería ocurrir (ya se validó 'programada' arriba), pero si pasa,
      // no se revierte lo ya insertado — queda para revisión administrativa,
      // nunca se pierde el registro de la transferencia.
      console.error(JSON.stringify({ requestId, scope: 'liquidaciones', reason: 'marcar_pagada_fallida', comisionId: d.comisionId }));
    }
  }

  await logEvento(db, requestId, {
    ventaId: null, entidad: 'liquidacion', entidadId: transferenciaId, estadoNuevo: 'registrada', usuarioEmail: actorEmail,
    motivoNota: `Liquidación de ${beneficiarioEmail}: ${detalle.length} comisión(es), total ${montoTotalTransferido} ${monedaFinal}.`,
  });

  return transferenciaId;
}

// Detalle completo de una liquidación — para reconciliar el total
// transferido contra las comisiones incluidas (criterio de aceptación de
// RIO-115).
export async function obtenerLiquidacion(db, requestId, transferenciaId) {
  const transferencias = await query(db, requestId, 'SELECT * FROM transferencias_comision WHERE id = ?', [transferenciaId]);
  const transferencia = transferencias[0];
  if (!transferencia) return null;
  const detalle = await query(db, requestId, 'SELECT * FROM transferencia_detalle WHERE transferencia_id = ?', [transferenciaId]);
  return { transferencia, detalle };
}
