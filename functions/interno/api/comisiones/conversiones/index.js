// POST /interno/api/comisiones/conversiones — RIO-115.
// Registra la conversión real ARS -> CLP de UNA comisión, ya operada a
// mano por administración en Global66 (nunca una API — el tipo de cambio
// que se informa acá es el que Global66 ya mostró, el sistema no lo
// calcula ni lo valida contra ninguna fuente externa). Exclusivo de
// administración.

import { ok, Errors } from '../../../../_shared/response.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { registrarConversion, LiquidacionError } from '../../../../_shared/liquidaciones.js';

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
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
  const { comisionId, montoOriginal, tipoCambioMostrado, costosODiferencias, montoConvertido, fechaConversion } = body || {};
  if (typeof comisionId !== 'string' || !comisionId.trim()) {
    return Errors.validation('Falta comisionId.', requestId);
  }
  if (!Number.isInteger(montoOriginal) || montoOriginal <= 0) {
    return Errors.validation('montoOriginal inválido.', requestId);
  }
  if (typeof tipoCambioMostrado !== 'number' || tipoCambioMostrado <= 0) {
    return Errors.validation('tipoCambioMostrado inválido.', requestId);
  }
  if (!Number.isInteger(montoConvertido) || montoConvertido <= 0) {
    return Errors.validation('montoConvertido inválido.', requestId);
  }

  try {
    const id = await registrarConversion(env.DB, requestId, {
      comisionId, montoOriginal, tipoCambioMostrado, costosODiferencias, montoConvertido, fechaConversion, registradoPor: roleIdentity.email,
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
