// POST /interno/api/ventas/:id/componentes/:componenteId/costos — RIO-114.
// Alta de un costo directo de ESTE componente (ej. dominio propio de una
// Landing Premium) — exclusivo de administración (RIO-97 v2 sección 6: "el
// costo pertenece al componente que lo genera", nunca a la venta completa).
// Solo afecta comisiones generadas DESPUÉS de este registro — nunca
// recalcula hacia atrás una comisión ya existente (snapshot inmutable).

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';
import { registrarCostoDirecto } from '../../../../../../_shared/comisiones.js';

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
    return Errors.forbidden(requestId); // costos directos: exclusivo de administración, igual que los avances oficiales.
  }

  const componenteRows = await query(env.DB, requestId, 'SELECT id FROM componentes WHERE id = ? AND proyecto_id IN (SELECT id FROM proyectos WHERE venta_id = ?)', [params.componenteId, venta.id]);
  if (!componenteRows[0]) return Errors.notFound(requestId);

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

  const id = await registrarCostoDirecto(env.DB, requestId, {
    componenteId: params.componenteId, tipo: body.tipo.trim(), monto: body.monto, moneda: venta.moneda,
    autorizadoPor: roleIdentity.email, nota: body.nota,
  });

  return ok({ id }, requestId, 201);
}
