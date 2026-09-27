// POST /interno/api/notificaciones/:notificacionId — RIO-116, segundo
// bloque. action: 'leer' | 'atender' — exclusivo de admin. Registra quién
// la marcó y cuándo (Brenda: "registrar creación, lectura y usuario que
// atendió la notificación") — nunca la borra ni pisa una marca anterior
// (ambas actualizaciones son idempotentes: si ya estaba leída/atendida,
// no se sobrescribe con un usuario/fecha distintos).

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { marcarNotificacionLeida, marcarNotificacionAtendida } from '../../../../_shared/notificaciones.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }
  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }

  const rows = await query(env.DB, requestId, 'SELECT id FROM notificaciones WHERE id = ?', [params.notificacionId]);
  if (!rows[0]) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action === 'leer') {
    await marcarNotificacionLeida(env.DB, requestId, { notificacionId: params.notificacionId, actorEmail: roleIdentity.email });
    return ok({ action: 'leer' }, requestId);
  }
  if (body?.action === 'atender') {
    await marcarNotificacionAtendida(env.DB, requestId, { notificacionId: params.notificacionId, actorEmail: roleIdentity.email });
    return ok({ action: 'atender' }, requestId);
  }
  return Errors.validation('action inválida. Valores permitidos: leer, atender.', requestId);
}
