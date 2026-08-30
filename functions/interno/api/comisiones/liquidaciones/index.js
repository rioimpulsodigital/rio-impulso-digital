// GET/POST /interno/api/comisiones/liquidaciones — RIO-115.
// POST: agrupa N comisiones de una misma persona en una única
// transferencia (una o ambas monedas) y las marca pagadas — exclusivo de
// administración. GET: lista — cada quien ve las suyas, admin ve todas.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { registrarLiquidacion, LiquidacionError } from '../../../../_shared/liquidaciones.js';

const VALID_MONEDAS = ['CLP', 'ARS'];

async function handleList(context) {
  const { env, data } = context;
  const { requestId, roleIdentity } = data;
  const rows = roleIdentity.role === 'admin'
    ? await query(env.DB, requestId, 'SELECT * FROM transferencias_comision ORDER BY fecha DESC', [])
    : await query(env.DB, requestId, 'SELECT * FROM transferencias_comision WHERE beneficiario_email = ? ORDER BY fecha DESC', [roleIdentity.email]);

  return ok({
    liquidaciones: rows.map((r) => ({
      id: r.id, beneficiarioEmail: r.beneficiario_email, fecha: r.fecha, monedaFinal: r.moneda_final,
      montoTotalTransferido: r.monto_total_transferido, registradoPor: r.registrado_por,
    })),
  }, requestId);
}

async function handleCreate(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }
  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  const { beneficiarioEmail, fecha, monedaFinal, comisionIds, montoTotalTransferido, comprobanteNota } = body || {};
  if (typeof beneficiarioEmail !== 'string' || !beneficiarioEmail.trim()) {
    return Errors.validation('Falta beneficiarioEmail.', requestId);
  }
  if (typeof fecha !== 'string' || !fecha.trim()) {
    return Errors.validation('Falta fecha.', requestId);
  }
  if (!VALID_MONEDAS.includes(monedaFinal)) {
    return Errors.validation('monedaFinal inválida.', requestId);
  }
  if (!Array.isArray(comisionIds) || comisionIds.length === 0) {
    return Errors.validation('comisionIds debe ser un arreglo con al menos un elemento.', requestId);
  }
  if (!Number.isInteger(montoTotalTransferido) || montoTotalTransferido <= 0) {
    return Errors.validation('montoTotalTransferido inválido.', requestId);
  }

  try {
    const id = await registrarLiquidacion(env.DB, requestId, {
      beneficiarioEmail, fecha, monedaFinal, comisionIds, montoTotalTransferido, comprobanteNota, actorEmail: roleIdentity.email,
    });
    return ok({ id }, requestId, 201);
  } catch (e) {
    if (e instanceof LiquidacionError) {
      const status = e.code === 'comision_no_encontrada' ? 404 : 409;
      return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
    }
    throw e;
  }
}

export async function onRequest(context) {
  const { request, data } = context;
  const { requestId } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  return request.method === 'GET' ? handleList(context) : handleCreate(context);
}
