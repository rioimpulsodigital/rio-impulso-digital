// GET /interno/api/equipos — RIO-118 (corrección, ventas administrativas
// y comisión de supervisión, 01/09/2026).
//
// Exclusivo de administración: lista los equipos comerciales de sus
// mercados autorizados, para que pueda elegir a cuál asignar una venta al
// cerrarla desde el Kit ("Venta directa de Administración — sin
// supervisión" es la alternativa, no un equipo — se resuelve en el
// frontend, no acá). Un vendedor normal nunca elige equipo: el suyo se
// resuelve automáticamente desde su asignación vigente (RIO-112+), este
// endpoint no le sirve para eso y no se le expone.

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { isMethodAllowed } from '../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (roleIdentity.permissions.viewOthersData !== true) {
    return Errors.forbidden(requestId); // exclusivo de administración — un supervisor no elige equipo ajeno.
  }
  if (roleIdentity.allowedMarkets.length === 0) {
    return ok({ equipos: [] }, requestId);
  }

  const placeholders = roleIdentity.allowedMarkets.map(() => '?').join(',');
  const rows = await query(
    env.DB, requestId,
    `SELECT id, nombre, mercado FROM equipos WHERE mercado IN (${placeholders}) ORDER BY mercado, nombre`,
    roleIdentity.allowedMarkets
  );

  return ok({ equipos: rows.map((e) => ({ id: e.id, nombre: e.nombre, mercado: e.mercado })) }, requestId);
}
