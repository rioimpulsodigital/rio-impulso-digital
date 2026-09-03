// POST /interno/api/equipos/:id — RIO-119 (segundo bloque, 02/09/2026).
// action: 'activar' | 'desactivar'. Exclusivo de administración.
//
// Desactivar un equipo NUNCA borra sus miembros/supervisores vigentes ni
// altera ninguna venta ya vinculada a él (equipo_id sigue siendo un
// snapshot inmutable, RIO-115) — solo lo saca de los selectores futuros
// (Kit, GET /equipos sin ?incluirInactivos=1).

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

  const equipoRows = await query(env.DB, requestId, 'SELECT id, nombre, estado FROM equipos WHERE id = ?', [params.id]);
  const equipo = equipoRows[0];
  if (!equipo) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (body?.action !== 'activar' && body?.action !== 'desactivar') {
    return Errors.validation('action inválida. Valores permitidos: activar, desactivar.', requestId);
  }

  const nuevoEstado = body.action === 'activar' ? 'activo' : 'inactivo';
  await execute(env.DB, requestId, 'UPDATE equipos SET estado = ? WHERE id = ?', [nuevoEstado, params.id]);
  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'equipo', entidadId: params.id, estadoAnterior: equipo.estado, estadoNuevo: nuevoEstado,
    usuarioEmail: roleIdentity.email, motivoNota: body.motivo || null,
  });

  return ok({ id: params.id, estado: nuevoEstado }, requestId);
}
