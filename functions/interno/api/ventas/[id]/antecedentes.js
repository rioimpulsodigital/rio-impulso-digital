// POST /interno/api/ventas/:id/antecedentes — RIO-113 corrección.
// "Agregar antecedentes u observaciones" (Brenda, sección 3 de sus
// decisiones definitivas del 28/08/2026): un dato reportado más, nunca
// cambia ningún estado oficial ni de pago — solo queda registrado en el
// historial append-only (mismo criterio que "el cliente manifestó
// aprobación" de la sección 4, que no es lo mismo que la aprobación
// oficial validada por administración).
//
// Puede agregarlo el vendedor de ESTA venta, o administración — mismo
// criterio de autorización que informar pagos/materiales.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { agregarAntecedente } from '../../../../_shared/proyectos.js';

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

  const esVendedor = roleIdentity.email === venta.vendedor_email;
  if (!esVendedor && !roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId); // un supervisor sin ser el vendedor no agrega antecedentes ajenos.
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (typeof body?.nota !== 'string' || !body.nota.trim()) {
    return Errors.validation('Falta la nota del antecedente.', requestId);
  }

  await agregarAntecedente(env.DB, requestId, { ventaId: venta.id, nota: body.nota.trim(), actorEmail: roleIdentity.email });

  return ok({ registrado: true }, requestId, 201);
}
