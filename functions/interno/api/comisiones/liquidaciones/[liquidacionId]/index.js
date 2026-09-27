// GET /interno/api/comisiones/liquidaciones/:liquidacionId — RIO-115.
// Detalle completo de una liquidación con su desglose — permite
// reconciliar el total transferido contra las comisiones incluidas
// (criterio de aceptación de RIO-115). El beneficiario ve la suya, admin
// ve cualquiera.

import { ok, Errors } from '../../../../../_shared/response.js';
import { isMethodAllowed } from '../../../../../_shared/security.js';
import { obtenerLiquidacion } from '../../../../../_shared/liquidaciones.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const resultado = await obtenerLiquidacion(env.DB, requestId, params.liquidacionId);
  if (!resultado) return Errors.notFound(requestId);

  const { transferencia, detalle } = resultado;
  if (roleIdentity.role !== 'admin' && transferencia.beneficiario_email !== roleIdentity.email) {
    return Errors.notFound(requestId); // mismo criterio del resto del sistema: no confirmar existencia ajena.
  }

  return ok({
    liquidacion: {
      id: transferencia.id, beneficiarioEmail: transferencia.beneficiario_email, fecha: transferencia.fecha,
      monedaFinal: transferencia.moneda_final, montoTotalTransferido: transferencia.monto_total_transferido,
      comprobanteNota: transferencia.comprobante_nota, registradoPor: transferencia.registrado_por,
    },
    detalle: detalle.map((d) => ({
      comisionId: d.comision_id, montoIncluido: d.monto_incluido, monedaOriginal: d.moneda_original, conversionId: d.conversion_id,
    })),
    sumaDetalle: detalle.reduce((sum, d) => sum + d.monto_incluido, 0),
  }, requestId);
}
