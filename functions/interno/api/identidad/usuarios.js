// GET /interno/api/identidad/usuarios — RIO-111.
// Lista cada usuario registrado junto con su asignación vigente (rol,
// mercados, estado). Base para el futuro panel administrativo (RIO-119) —
// acá solo la lectura, protegida por rol.
//
// Rol-gated: únicamente `admin` (permissions.manageUsers). Cualquier otro
// rol recibe 403 — sin excepción, sin importar qué parámetros envíe.

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { isMethodAllowed } from '../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  if (!roleIdentity.permissions.manageUsers) {
    console.warn(JSON.stringify({ requestId, scope: 'usuarios', reason: 'non_admin_listing_blocked' }));
    return Errors.forbidden(requestId);
  }

  const rows = await query(
    env.DB,
    requestId,
    `SELECT u.email, u.nombre, a.role, a.allowed_markets, a.default_market, a.user_status, a.valid_from, a.valid_until
     FROM usuarios u
     JOIN asignaciones_rol a ON a.usuario_id = u.id
       AND (a.valid_until IS NULL OR a.valid_until > datetime('now'))
       AND a.valid_from <= datetime('now')
     ORDER BY u.nombre ASC`
  );

  const usuarios = rows.map((r) => ({
    email: r.email,
    nombre: r.nombre,
    role: r.role,
    allowedMarkets: JSON.parse(r.allowed_markets),
    defaultMarket: r.default_market,
    userStatus: r.user_status,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  }));

  return ok({ usuarios }, requestId);
}
