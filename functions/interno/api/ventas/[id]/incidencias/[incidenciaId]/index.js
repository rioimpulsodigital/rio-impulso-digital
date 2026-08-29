// POST /interno/api/ventas/:id/incidencias/:incidenciaId — RIO-114.
// action: 'resolver' — exclusivo de administración, igual que crear la
// incidencia. Necesario para que la condición "venta firme y sin disputa"
// de la comisión (RIO-114) pueda dejar de estar bloqueada cuando la
// disputa se resuelve — hasta ahora ninguna ruta usaba el campo `estado`
// de `incidencias` (existente desde la migración 0007).

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { resolverIncidencia, ProyectoError } from '../../../../../../_shared/proyectos.js';
import { reevaluarComisionesDeVenta } from '../../../../../../_shared/comisiones.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!roleIdentity.permissions.manageIncidencias) {
    return Errors.forbidden(requestId);
  }
  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id FROM ventas WHERE id = ?', [params.id]);
  if (!ventaRows[0]) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (body?.action !== 'resolver') {
    return Errors.validation('action inválida. Valor permitido: resolver.', requestId);
  }

  try {
    const ventaId = await resolverIncidencia(env.DB, requestId, { incidenciaId: params.incidenciaId, actorEmail: roleIdentity.email });
    await reevaluarComisionesDeVenta(env.DB, requestId, ventaId, roleIdentity.email);
    return ok({ action: 'resolver' }, requestId);
  } catch (e) {
    if (e instanceof ProyectoError) {
      const status = e.code === 'incidencia_no_encontrada' ? 404 : 409;
      return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
    }
    throw e;
  }
}
