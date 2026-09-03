// POST /interno/api/plantillas-distribucion/:id — RIO-119 (tercer bloque,
// item 5, 03/09/2026). Exclusivo de administración.
//
// action 'desactivar'/'activar': cambia el estado — nunca se borra una
// plantilla (proyectos ya creados pueden seguir referenciándola por id).

import { ok, Errors } from '../../../../_shared/response.js';
import { query, execute } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { logEvento } from '../../../../_shared/historial.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  const rows = await query(env.DB, requestId, 'SELECT id, estado FROM plantillas_distribucion WHERE id = ?', [params.id]);
  const plantilla = rows[0];
  if (!plantilla) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action !== 'desactivar' && body?.action !== 'activar') {
    return Errors.validation('action inválida. Valores permitidos: desactivar, activar.', requestId);
  }
  const nuevoEstado = body.action === 'desactivar' ? 'inactivo' : 'activo';
  if (plantilla.estado === nuevoEstado) return Errors.validation(`La plantilla ya está ${nuevoEstado}.`, requestId);

  await execute(env.DB, requestId, 'UPDATE plantillas_distribucion SET estado = ? WHERE id = ?', [nuevoEstado, plantilla.id]);
  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'plantilla_distribucion', entidadId: plantilla.id, estadoAnterior: plantilla.estado, estadoNuevo: nuevoEstado,
    usuarioEmail: roleIdentity.email, motivoNota: body.motivo || null,
  });
  return ok({ id: plantilla.id, estado: nuevoEstado }, requestId);
}
