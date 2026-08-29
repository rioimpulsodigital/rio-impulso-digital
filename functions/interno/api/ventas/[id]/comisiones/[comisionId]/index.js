// POST /interno/api/ventas/:id/comisiones/:comisionId — RIO-114.
// action: 'marcar-pagada' — exclusivo de administración ("Habilitar,
// retener, programar, pagar comisiones" es admin-exclusivo, RIO-97 v2
// sección 4). Solo transiciona desde 'programada' — nunca se paga algo que
// no llegó a programarse (criterio de aceptación de RIO-114: "habilitación
// separada de programación y pago").

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';
import { marcarComisionPagada, ComisionError } from '../../../../../../_shared/comisiones.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    assertCanAccessOwner(roleIdentity, venta.vendedor_email, venta.mercado);
  } catch (e) {
    if (e instanceof AuthzError) return Errors.notFound(requestId);
    throw e;
  }

  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId); // pagar comisiones: exclusivo de administración.
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (body?.action !== 'marcar-pagada') {
    return Errors.validation('action inválida. Valor permitido: marcar-pagada.', requestId);
  }

  try {
    await marcarComisionPagada(env.DB, requestId, { comisionId: params.comisionId, actorEmail: roleIdentity.email, fechaPagoReal: body.fechaPagoReal });
    return ok({ action: 'marcar-pagada' }, requestId);
  } catch (e) {
    if (e instanceof ComisionError) {
      const status = e.code === 'comision_no_encontrada' ? 404 : 409;
      return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
    }
    throw e;
  }
}
