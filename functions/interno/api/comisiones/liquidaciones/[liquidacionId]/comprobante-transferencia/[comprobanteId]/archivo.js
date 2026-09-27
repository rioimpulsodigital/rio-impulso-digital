// GET .../liquidaciones/:liquidacionId/comprobante-transferencia/:comprobanteId/archivo
// RIO-116 — bytes reales del comprobante de transferencia. Mismo criterio
// de acceso que el índice: beneficiario de la liquidación, o admin.

import { Errors } from '../../../../../../../_shared/response.js';
import { query } from '../../../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../../../_shared/security.js';
import { respuestaArchivoSeguro } from '../../../../../../../_shared/comprobantes.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const rows = await query(env.DB, requestId, 'SELECT id, beneficiario_email FROM transferencias_comision WHERE id = ?', [params.liquidacionId]);
  const liquidacion = rows[0];
  if (!liquidacion) return Errors.notFound(requestId);

  const esBeneficiario = roleIdentity.email === liquidacion.beneficiario_email;
  const esAdmin = !!roleIdentity.permissions.manageProduccionOficial;
  if (!esBeneficiario && !esAdmin) return Errors.forbidden(requestId);

  const comprobanteRows = await query(
    env.DB, requestId,
    "SELECT * FROM comprobantes WHERE id = ? AND tipo = 'transferencia' AND referencia_id = ?",
    [params.comprobanteId, liquidacion.id]
  );
  const comprobante = comprobanteRows[0];
  if (!comprobante) return Errors.notFound(requestId);

  const object = await env.COMPROBANTES.get(comprobante.r2_key);
  if (!object) {
    console.error(JSON.stringify({ requestId, scope: 'comprobantes', reason: 'objeto_r2_faltante', comprobanteId: comprobante.id }));
    return Errors.internal(requestId);
  }

  return respuestaArchivoSeguro(object, comprobante);
}
