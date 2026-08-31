// POST /interno/api/comisiones/asignaciones-produccion — RIO-114,
// extendido en RIO-115 con `rol` ('produccion' | 'desarrollo').
// Asigna a una persona un componente para un rol específico — el
// prerrequisito real para que pueda generarse esa comisión (RIO-97 v2:
// "hoy sin nadie asignado"). Exclusivo de administración. Un componente
// admite hasta una persona asignada POR ROL (UNIQUE(componente_id, rol),
// migración 0014) — la misma persona puede ocupar ambos roles sobre el
// mismo componente (ej. produce y también desarrolla), pero asignar el
// mismo rol dos veces devuelve 409, nunca sobrescribe en silencio.

import { ok, Errors } from '../../../../_shared/response.js';
import { query, execute } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';

const VALID_ROLES = ['produccion', 'desarrollo'];

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
  if (!VALID_ROLES.includes(body?.rol)) {
    return Errors.validation('rol inválido. Valores permitidos: produccion, desarrollo.', requestId);
  }

  const componenteRows = await query(env.DB, requestId, 'SELECT id, tipo FROM componentes WHERE id = ?', [body.componenteId]);
  const componente = componenteRows[0];
  if (!componente) return Errors.notFound(requestId);
  if (componente.tipo !== 'landing') {
    return Errors.validation('Solo se puede asignar producción o desarrollo a un componente Landing — esta distribución no aplica a Ficha.', requestId);
  }

  const yaAsignado = await query(env.DB, requestId, 'SELECT id FROM asignaciones_produccion WHERE componente_id = ? AND rol = ?', [body.componenteId, body.rol]);
  if (yaAsignado[0]) {
    return Errors.conflict('ROL_YA_ASIGNADO', `Este componente ya tiene a alguien asignado como "${body.rol}".`, requestId);
  }

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    'INSERT INTO asignaciones_produccion (id, usuario_email, componente_id, rol, asignado_por) VALUES (?, ?, ?, ?, ?)',
    [id, body.usuarioEmail.trim(), body.componenteId, body.rol, roleIdentity.email]
  );

  return ok({ id }, requestId, 201);
}
