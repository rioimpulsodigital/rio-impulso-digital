// POST /interno/api/ventas/:id/incidencias — RIO-113.
// Cancelación, devolución, reclamo o disputa — SOLO admin (RIO-97 v2
// sección 5: "Cancelar/registrar devolución o disputa: admin únicamente").
// Nunca borra nada — agrega una incidencia y un evento en el historial.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { registrarIncidencia } from '../../../../_shared/proyectos.js';

const VALID_TIPOS = ['cancelacion', 'devolucion', 'reclamo', 'disputa'];

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
  if (!VALID_TIPOS.includes(body?.tipo)) {
    return Errors.validation('tipo inválido. Valores permitidos: cancelacion, devolucion, reclamo, disputa.', requestId);
  }
  if (typeof body.motivo !== 'string' || !body.motivo.trim()) {
    return Errors.validation('Falta el motivo de la incidencia.', requestId);
  }

  const id = await registrarIncidencia(env.DB, requestId, {
    ventaId: params.id, tipo: body.tipo, motivo: body.motivo.trim(), actorEmail: roleIdentity.email,
  });

  return ok({ id, tipo: body.tipo }, requestId, 201);
}
