// GET /interno/api/comisiones — RIO-122 (conectar Liquidaciones al Panel
// Administrativo). Lista comisiones elegibles para agruparse en una
// liquidación — exclusivo de administración, dentro de sus mercados
// autorizados. Hoy el único valor soportado de `estado` es 'programada':
// es la única transición real hacia 'pagada' que puede pasar por acá
// (por Liquidaciones, RIO-115) o por el endpoint individual de excepción
// (POST /ventas/:id/comisiones/:comisionId, acción marcar-pagada) — nunca
// por otro camino.
//
// No duplica ninguna regla de cálculo ni de estados: solo lee lo que
// evaluateComisionGate() ya decidió (functions/_shared/comisiones.js) y
// agrega el contexto de venta/cliente/conversión que la UI necesita para
// armar la selección. La validación real de qué se puede liquidar (un
// solo beneficiario, reconciliación exacta, conversión previa para ARS,
// nunca una comisión ya liquidada) sigue viviendo exclusivamente en
// registrarLiquidacion() (functions/_shared/liquidaciones.js) — esta
// ruta nunca decide, solo informa.
//
// Las comisiones de proyecto personalizado (liberación por cuota,
// `comision_liberaciones`) quedan afuera sin necesidad de excluirlas a
// mano: su fila en `comisiones` permanece en 'calculada_provisional'
// para siempre (migración 0030) — el filtro por estado='programada' ya
// las descarta.

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { isMethodAllowed } from '../../../_shared/security.js';

async function serialize(db, requestId, c) {
  const [nombreRows, ventaRows, conversionRows] = await Promise.all([
    query(db, requestId, 'SELECT nombre FROM usuarios WHERE email = ?', [c.beneficiario_email]),
    query(db, requestId, 'SELECT codigo_venta, mercado, cliente_id FROM ventas WHERE id = ?', [c.venta_id]),
    query(db, requestId, 'SELECT id, monto_convertido, moneda_final, tipo_cambio_mostrado, monto_original FROM conversiones WHERE comision_id = ?', [c.id]),
  ]);
  const venta = ventaRows[0] || {};
  const clienteRows = venta.cliente_id
    ? await query(db, requestId, 'SELECT negocio FROM clientes WHERE id = ?', [venta.cliente_id])
    : [];
  const conversion = conversionRows[0] || null;

  return {
    id: c.id,
    tipo: c.tipo,
    ventaId: c.venta_id,
    codigoVenta: venta.codigo_venta || null,
    clienteNegocio: clienteRows[0]?.negocio || null,
    mercado: venta.mercado || null,
    beneficiarioEmail: c.beneficiario_email,
    beneficiarioNombre: nombreRows[0]?.nombre || null,
    moneda: c.moneda,
    montoComision: c.monto_comision,
    fechaProgramadaEfectiva: c.fecha_programada_efectiva,
    conversion: conversion ? {
      id: conversion.id,
      montoConvertido: conversion.monto_convertido,
      monedaFinal: conversion.moneda_final,
      tipoCambioMostrado: conversion.tipo_cambio_mostrado,
      montoOriginal: conversion.monto_original,
    } : null,
    // Solo tiene sentido para una comisión en ARS todavía sin conversión
    // — nunca para CLP (nunca necesita convertirse) ni para una que ya
    // tiene su conversión registrada (registrarConversion() rechaza una
    // segunda conversión de la misma comisión, RIO-115).
    requiereConversion: c.moneda === 'ARS' && !conversion,
  };
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }

  const url = new URL(request.url);
  const estado = url.searchParams.get('estado');
  if (estado !== 'programada') {
    return Errors.validation("estado inválido. Valor permitido: 'programada'.", requestId);
  }

  if (roleIdentity.allowedMarkets.length === 0) {
    return ok({ comisiones: [] }, requestId);
  }
  const placeholders = roleIdentity.allowedMarkets.map(() => '?').join(',');
  const rows = await query(
    env.DB, requestId,
    `SELECT c.* FROM comisiones c JOIN ventas v ON v.id = c.venta_id
     WHERE c.estado = 'programada' AND v.mercado IN (${placeholders})
     ORDER BY c.fecha_programada_efectiva ASC`,
    roleIdentity.allowedMarkets
  );

  return ok({ comisiones: await Promise.all(rows.map((c) => serialize(env.DB, requestId, c))) }, requestId);
}
