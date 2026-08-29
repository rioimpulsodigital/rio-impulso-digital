// POST /interno/api/comisiones/asignaciones-produccion — RIO-114.
// Asigna un asistente/practicante a un componente específico — el
// prerrequisito real para que pueda generarse su comisión de producción
// (RIO-97 v2: "hoy sin nadie asignado"). Exclusivo de administración. Un
// componente admite un único asistente asignado en esta etapa (columna
// UNIQUE, migración 0011) — asignarlo dos veces devuelve 409, nunca
// sobrescribe en silencio.

import { ok, Errors } from '../../../../_shared/response.js';
import { query, execute } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, data } = context;
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (typeof body?.componenteId !== 'string' || !body.componenteId.trim()) {
    return Errors.validation('Falta componenteId.', requestId);
  }
  if (typeof body?.usuarioEmail !== 'string' || !body.usuarioEmail.trim()) {
    return Errors.validation('Falta usuarioEmail.', requestId);
  }

  const componenteRows = await query(env.DB, requestId, 'SELECT id FROM componentes WHERE id = ?', [body.componenteId]);
  if (!componenteRows[0]) return Errors.notFound(requestId);

  const yaAsignado = await query(env.DB, requestId, 'SELECT id FROM asignaciones_produccion WHERE componente_id = ?', [body.componenteId]);
  if (yaAsignado[0]) {
    return Errors.conflict('COMPONENTE_YA_ASIGNADO', 'Este componente ya tiene un asistente asignado.', requestId);
  }

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    'INSERT INTO asignaciones_produccion (id, usuario_email, componente_id, asignado_por) VALUES (?, ?, ?, ?)',
    [id, body.usuarioEmail.trim(), body.componenteId, roleIdentity.email]
  );

  return ok({ id }, requestId, 201);
}
