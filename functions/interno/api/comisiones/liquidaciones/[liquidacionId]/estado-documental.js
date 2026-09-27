// GET /interno/api/comisiones/liquidaciones/:liquidacionId/estado-documental
// RIO-116, segundo bloque (Brenda, sección 3) — 5 estados posibles:
// sin_comprobantes, conversion_documentada, transferencia_documentada,
// documentacion_completa, rechazado_pendiente_reemplazo. Deliberadamente
// separado del estado de PAGO de las comisiones (marcar una liquidación
// pagada y tener su documentación completa son hechos relacionados, pero
// distintos) — este endpoint nunca modifica nada, solo informa.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query } from '../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../_shared/security.js';
import { calcularEstadoDocumentalLiquidacion } from '../../../../../_shared/comprobantes.js';

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

  const estado = await calcularEstadoDocumentalLiquidacion(env.DB, requestId, liquidacion.id);
  return ok({ estadoDocumental: estado }, requestId);
}
