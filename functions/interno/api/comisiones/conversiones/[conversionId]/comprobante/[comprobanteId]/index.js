// POST /interno/api/comisiones/conversiones/:conversionId/comprobante/:comprobanteId
// RIO-116 — action: 'rechazar' (exclusivo de admin). Marca el comprobante
// VIGENTE como rechazado (motivo obligatorio) sin borrarlo ni tocar el
// registro de la conversión en sí — queda "pendiente de reemplazo" hasta
// que se suba una versión nueva.

import { ok, Errors } from '../../../../../../../_shared/response.js';
import { query } from '../../../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../../_shared/security.js';
import { rechazarComprobante, ComprobanteError } from '../../../../../../../_shared/comprobantes.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
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

  const rows = await query(env.DB, requestId, 'SELECT id FROM conversiones WHERE id = ?', [params.conversionId]);
  if (!rows[0]) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (body?.action !== 'rechazar') {
    return Errors.validation('action inválida. Valor permitido: rechazar.', requestId);
  }
  if (typeof body.motivo !== 'string' || !body.motivo.trim()) {
    return Errors.validation('Falta motivo.', requestId);
  }

  try {
    await rechazarComprobante(env.DB, requestId, {
      tipo: 'conversion', referenciaId: params.conversionId, comprobanteIdEsperado: params.comprobanteId,
      motivo: body.motivo.trim(), actorEmail: roleIdentity.email,
    });
    return ok({ action: 'rechazar' }, requestId);
  } catch (e) {
    if (e instanceof ComprobanteError) {
      return e.code === 'comprobante_no_encontrado' ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
    }
    throw e;
  }
}
