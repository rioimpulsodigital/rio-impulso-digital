// GET/POST /interno/api/ventas/:id/comisiones/:comisionId/adelantos —
// RIO-119 (quinto bloque, 04/09/2026). Exclusivo de administración (misma
// capacidad que gestiona planes de comisión y la distribución económica —
// esto es dinero de personas, nunca visible para supervisor/vendedor/
// asistente).
//
// Un adelanto NUNCA reemplaza la comisión original — GET siempre devuelve
// el monto original, los adelantos acumulados y el saldo, nunca oculta
// nada. Idempotente vía idempotencyKey (header Idempotency-Key o body) —
// mismo criterio que ventas.idempotency_key.

import { ok, Errors } from '../../../../../../../_shared/response.js';
import { query } from '../../../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../../_shared/security.js';
import { registrarAdelanto, saldoDisponibleComision, AdelantoError } from '../../../../../../../_shared/comisiones.js';

function serializeAdelanto(row) {
  return {
    id: row.id,
    beneficiarioEmail: row.beneficiario_email,
    monto: row.monto,
    moneda: row.moneda,
    medioPago: row.medio_pago || null,
    comprobanteReferencia: row.comprobante_referencia || null,
    motivo: row.motivo,
    autorizadoPor: row.autorizado_por,
    autoautorizado: !!row.autoautorizado,
    saldoAnterior: row.saldo_anterior,
    saldoPosterior: row.saldo_posterior,
    estado: row.estado,
    createdAt: row.created_at,
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const comisionRows = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE id = ? AND venta_id = ?', [params.comisionId, params.id]);
  const comision = comisionRows[0];
  if (!comision) return Errors.notFound(requestId);

  if (request.method === 'GET') {
    const adelantos = await query(env.DB, requestId, 'SELECT * FROM comision_adelantos WHERE comision_id = ? ORDER BY created_at ASC', [comision.id]);
    const saldo = await saldoDisponibleComision(env.DB, requestId, comision.id);
    const adelantado = adelantos.reduce((s, a) => s + a.monto, 0);
    return ok({
      comision: {
        id: comision.id, beneficiarioEmail: comision.beneficiario_email, montoOriginal: comision.monto_comision,
        moneda: comision.moneda, esEstimacion: !!comision.es_estimacion, estado: comision.estado,
        adelantosAcumulados: adelantado, saldoPendiente: saldo,
      },
      adelantos: adelantos.map(serializeAdelanto),
    }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const idempotencyKey = request.headers.get('Idempotency-Key') || body.idempotencyKey;
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return Errors.validation('Falta idempotencyKey (o el header Idempotency-Key).', requestId);
  }
  if (!Number.isInteger(body.monto) || body.monto <= 0) return Errors.validation('monto debe ser un entero positivo.', requestId);
  if (body.moneda !== 'CLP' && body.moneda !== 'ARS') return Errors.validation('moneda inválida.', requestId);
  if (typeof body.motivo !== 'string' || !body.motivo.trim()) return Errors.validation('Falta motivo.', requestId);

  try {
    const adelanto = await registrarAdelanto(env.DB, requestId, {
      comisionId: comision.id, monto: body.monto, moneda: body.moneda, medioPago: body.medioPago || undefined,
      comprobanteReferencia: body.comprobanteReferencia || undefined, motivo: body.motivo.trim(),
      actorEmail: roleIdentity.email, idempotencyKey,
    });
    return ok({ adelanto: serializeAdelanto(adelanto) }, requestId, 201);
  } catch (e) {
    if (e instanceof AdelantoError) {
      const status = e.code === 'comision_no_encontrada' ? 404 : 409;
      return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
    }
    throw e;
  }
}
