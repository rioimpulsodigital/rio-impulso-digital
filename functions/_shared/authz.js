// Autorización — RIO-111. Resuelve rol, mercados autorizados y permisos a
// partir de la identidad YA verificada por Cloudflare Access (RIO-110,
// access.js) contra la única fuente de autoridad: D1 (usuarios +
// asignaciones_rol, migración 0003). Nunca lee ni duplica `users.js` —
// ese archivo sigue existiendo solo para personalización de interfaz sin
// datos financieros (RIO-97 v2 sección 19).
//
// Principio: ninguna función de este archivo compara un email contra un
// valor fijo en el código. Todo permiso se resuelve leyendo `role`,
// `allowed_markets` y `user_status` de la fila vigente en D1 — nunca una
// condición por nombre propio.

import { Errors } from './response.js';

export class AuthzError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'AuthzError';
    this.reason = reason; // código interno corto — nunca se expone tal cual al cliente.
  }
}

// Matriz de permisos por rol (RIO-97 v2 sección 4, "Matriz de permisos por
// rol") — configuración fija del sistema, no un dato por usuario. Vive en
// código (no en D1) porque describe una regla de negocio estable, igual
// para cualquier persona con ese rol; si en el futuro Brenda pide que sea
// editable sin desplegar código, se puede mover a una tabla `permisos` sin
// cambiar la forma de `resolveRoleIdentity()`.
export const PERMISSIONS = Object.freeze({
  admin: Object.freeze({
    viewAllOwnMarkets: true, // ve todos los mercados de su allowedMarkets (CL+AR)
    viewOthersData: true, // puede ver datos de cualquier ejecutivo/supervisor/asistente
    manageUsers: true, // alta/baja/cambio de rol y mercado (RIO-119)
  }),
  supervisor: Object.freeze({
    viewAllOwnMarkets: true,
    viewOthersData: 'sameMarketOnly', // solo de personas cuyo mercado esté en su allowedMarkets
    manageUsers: false,
  }),
  ejecutivo: Object.freeze({
    viewAllOwnMarkets: true,
    viewOthersData: false, // nunca — solo sus propios clientes/ventas/comisiones
    manageUsers: false,
  }),
  asistente: Object.freeze({
    viewAllOwnMarkets: false, // no navega por mercado — solo por proyecto/componente asignado
    viewOthersData: false,
    manageUsers: false,
  }),
});

function parseAllowedMarkets(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Busca la asignación vigente de un email: existe en `usuarios`, tiene al
// menos una fila en `asignaciones_rol` con valid_until NULL o futuro, y esa
// fila tiene user_status = 'activo'. Cualquier otro caso es bloqueo — nunca
// se asume un rol por defecto ni se deja pasar "por las dudas".
export async function resolveRoleIdentity(db, email, requestId) {
  let userRow;
  try {
    userRow = await db.prepare('SELECT id, email, nombre FROM usuarios WHERE email = ?').bind(email).first();
  } catch (e) {
    console.error(JSON.stringify({ requestId, scope: 'authz', reason: 'user_lookup_failed' }));
    throw new AuthzError('lookup_failed');
  }
  if (!userRow) throw new AuthzError('user_not_registered');

  let assignmentRow;
  try {
    assignmentRow = await db
      .prepare(
        `SELECT role, allowed_markets, default_market, user_status, valid_from, valid_until
         FROM asignaciones_rol
         WHERE usuario_id = ?
           AND (valid_until IS NULL OR valid_until > datetime('now'))
           AND valid_from <= datetime('now')
         ORDER BY valid_from DESC
         LIMIT 1`
      )
      .bind(userRow.id)
      .first();
  } catch (e) {
    console.error(JSON.stringify({ requestId, scope: 'authz', reason: 'assignment_lookup_failed' }));
    throw new AuthzError('lookup_failed');
  }
  if (!assignmentRow) throw new AuthzError('no_active_assignment');
  if (assignmentRow.user_status !== 'activo') throw new AuthzError('user_inactive');

  const role = assignmentRow.role;
  const permissions = PERMISSIONS[role];
  if (!permissions) {
    // Rol presente en D1 pero fuera del set conocido por el código — nunca
    // se asume un permiso por defecto ante un valor inesperado.
    console.error(JSON.stringify({ requestId, scope: 'authz', reason: 'unknown_role', role }));
    throw new AuthzError('unknown_role');
  }

  const allowedMarkets = parseAllowedMarkets(assignmentRow.allowed_markets);
  return {
    email: userRow.email,
    nombre: userRow.nombre,
    role,
    allowedMarkets,
    // Defensivo: si por algún motivo default_market quedó vacío (no debería,
    // ver migración 0005), cae al primer mercado autorizado — nunca a un
    // mercado fijo hardcodeado ni a "sin mercado".
    defaultMarket: assignmentRow.default_market || allowedMarkets[0] || null,
    userStatus: assignmentRow.user_status,
    validFrom: assignmentRow.valid_from,
    validUntil: assignmentRow.valid_until,
    permissions,
  };
}

// Middleware reutilizable (RIO-112): resuelve `context.data.roleIdentity` a
// partir del email ya verificado por Access, con denegación por defecto —
// usado por functions/interno/api/identidad/_middleware.js (RIO-111) y por
// functions/interno/api/ventas/_middleware.js (RIO-112). Vive acá para que
// ningún directorio nuevo tenga que reimplementar esta misma resolución
// (el mismo tipo de duplicación que RIO-111 tuvo que corregir en users.js).
export async function requireRoleIdentity(context) {
  const { env, data, next } = context;
  const { requestId, identity } = data;

  let roleIdentity;
  try {
    roleIdentity = await resolveRoleIdentity(env.DB, identity.email, requestId);
  } catch (e) {
    if (e instanceof AuthzError) {
      console.warn(JSON.stringify({ requestId, scope: 'authz', reason: e.reason }));
    } else {
      console.error(JSON.stringify({ requestId, scope: 'authz', reason: 'unexpected_error' }));
    }
    return Errors.forbidden(requestId);
  }

  context.data.roleIdentity = roleIdentity;
  return next();
}

// Un mercado solo es válido para esta identidad si está en su lista de
// mercados autorizados vigente — igual para cualquier rol, incluido admin
// (RIO-97 v2: el admin también tiene su propio allowedMarkets, hoy CL+AR,
// no un bypass implícito de "ve todo sin condición").
export function assertMarketAllowed(roleIdentity, market) {
  if (!roleIdentity.allowedMarkets.includes(market)) {
    throw new AuthzError('market_not_allowed');
  }
}

// Autorización de acceso a un recurso de otra persona (ej. las ventas de un
// ejecutivo). `ownerEmail` es el email dueño del recurso solicitado;
// `ownerMarket` es el mercado de ese recurso (obligatorio para cualquier
// recurso con mercado — ventas, proyectos, componentes).
// - admin: permitido si `ownerMarket` está en su propio allowedMarkets —
//   RIO-112 corrige acá un caso no cubierto en la v1 de RIO-111: el admin
//   NO tiene un bypass implícito de mercado (mismo principio ya documentado
//   en assertMarketAllowed, ahora aplicado también acá). Hoy es invisible
//   porque Brenda (única admin) tiene CL+AR, pero un futuro admin con un
//   solo mercado autorizado debe quedar igual de limitado.
// - supervisor: permitido solo si `ownerMarket` está en su allowedMarkets.
// - ejecutivo / asistente: permitido únicamente si el recurso es propio
//   (ownerEmail === roleIdentity.email) — nunca de otra persona, sin
//   excepción, ni siquiera con un parámetro que diga lo contrario.
export function assertCanAccessOwner(roleIdentity, ownerEmail, ownerMarket) {
  if (ownerEmail === roleIdentity.email) return; // siempre puede ver lo propio.
  const canBypassOwnership = roleIdentity.permissions.viewOthersData === true // admin
    || roleIdentity.permissions.viewOthersData === 'sameMarketOnly'; // supervisor
  if (canBypassOwnership && ownerMarket && roleIdentity.allowedMarkets.includes(ownerMarket)) {
    return;
  }
  throw new AuthzError('resource_not_owned');
}
