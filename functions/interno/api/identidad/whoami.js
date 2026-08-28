// GET /interno/api/identidad/whoami — RIO-111.
// Devuelve la identidad resuelta (rol, mercados autorizados, estado,
// vigencia, permisos) de quien hace la solicitud — ya validada por Access
// (middleware padre) y por D1 (middleware de esta carpeta, authz.js).
//
// `?email=` es una función legítima de administrador (buscar la identidad
// de otra persona, ej. para el futuro panel de RIO-119) — NUNCA se honra
// para nadie que no sea admin. Un ejecutivo que intente pedir los datos de
// otro cambiando ese parámetro recibe 403, siempre recibe su propia
// identidad, nunca la de otro — esta es la prueba directa de que la
// autorización se resuelve en el servidor, no ocultando un campo en la
// interfaz (RIO-111, requisito 14).

import { ok, Errors } from '../../../_shared/response.js';
import { resolveRoleIdentity, AuthzError } from '../../../_shared/authz.js';
import { isMethodAllowed } from '../../../_shared/security.js';

function serialize(roleIdentity) {
  return {
    email: roleIdentity.email,
    nombre: roleIdentity.nombre,
    role: roleIdentity.role,
    allowedMarkets: roleIdentity.allowedMarkets,
    userStatus: roleIdentity.userStatus,
    validFrom: roleIdentity.validFrom,
    validUntil: roleIdentity.validUntil,
    permissions: roleIdentity.permissions,
  };
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const url = new URL(request.url);
  const requestedEmail = url.searchParams.get('email');

  if (!requestedEmail || requestedEmail === roleIdentity.email) {
    return ok(serialize(roleIdentity), requestId);
  }

  // A partir de acá: alguien pidió explícitamente la identidad de OTRO email.
  if (roleIdentity.role !== 'admin') {
    console.warn(JSON.stringify({ requestId, scope: 'whoami', reason: 'impersonation_attempt_blocked' }));
    return Errors.forbidden(requestId);
  }

  try {
    const target = await resolveRoleIdentity(env.DB, requestedEmail, requestId);
    return ok(serialize(target), requestId);
  } catch (e) {
    if (e instanceof AuthzError) {
      return Errors.notFound(requestId);
    }
    throw e;
  }
}
