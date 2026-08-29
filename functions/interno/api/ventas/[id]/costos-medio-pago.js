// POST /interno/api/ventas/:id/costos-medio-pago — RIO-114.
// Costo directo del medio de pago (comisión bancaria, costo real de la
// pasarela, etc.) que aplica a TODA la venta, no a un componente puntual.
// En un pack, se prorratea entre sus componentes con el mismo criterio
// proporcional que la distribución del precio del pack (RIO-97 v2 sección
// 6) — nunca se carga arbitrariamente a uno solo. Exclusivo de
// administración, igual que el resto de costos directos.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { registrarCostoMedioPago, ComisionError } from '../../../../_shared/comisiones.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado, moneda FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    assertCanAccessOwner(roleIdentity, venta.vendedor_email, venta.mercado);
  } catch (e) {
    if (e instanceof AuthzError) return Errors.notFound(requestId);
    throw e;
  }
  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (typeof body?.tipo !== 'string' || !body.tipo.trim()) {
    return Errors.validation('Falta el tipo de costo.', requestId);
  }
  if (!Number.isInteger(body.monto) || body.monto <= 0) {
    return Errors.validation('monto inválido.', requestId);
  }

  try {
    const ids = await registrarCostoMedioPago(env.DB, requestId, {
      ventaId: venta.id, tipo: body.tipo.trim(), monto: body.monto, moneda: venta.moneda, autorizadoPor: roleIdentity.email, nota: body.nota,
    });
    return ok({ ids }, requestId, 201);
  } catch (e) {
    if (e instanceof ComisionError) return Errors.notFound(requestId);
    throw e;
  }
}
