// GET/POST /interno/api/equipos — RIO-118 (GET original) + RIO-119
// (segundo bloque — administración de personas y equipos, 02/09/2026).
//
// GET: exclusivo de administración: lista los equipos comerciales de sus
// mercados autorizados, para que pueda elegir a cuál asignar una venta al
// cerrarla desde el Kit ("Venta directa de Administración — sin
// supervisión" es la alternativa, no un equipo — se resuelve en el
// frontend, no acá). Un vendedor normal nunca elige equipo: el suyo se
// resuelve automáticamente desde su asignación vigente (RIO-112+), este
// endpoint no le sirve para eso y no se le expone. Solo devuelve equipos
// 'activo' salvo que se pida `?incluirInactivos=1` — el selector del Kit
// nunca debe ofrecer un equipo desactivado, pero el panel de gestión sí
// necesita verlos para poder reactivarlos.
//
// POST: crea un equipo nuevo (nombre + mercado, estado 'activo' por
// defecto) — exclusivo de administración.

import { ok, Errors } from '../../../_shared/response.js';
import { query, execute } from '../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../_shared/security.js';
import { logEvento } from '../../../_shared/historial.js';

const VALID_MERCADOS = ['CL', 'AR'];

export async function onRequest(context) {
  const { request } = context;
  if (!isMethodAllowed(request, ['GET', 'POST'])) {
    return Errors.methodNotAllowed(context.data.requestId);
  }
  return request.method === 'GET' ? handleList(context) : handleCreate(context);
}

async function handleList(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (roleIdentity.permissions.viewOthersData !== true) {
    return Errors.forbidden(requestId); // exclusivo de administración — un supervisor no elige equipo ajeno.
  }
  if (roleIdentity.allowedMarkets.length === 0) {
    return ok({ equipos: [] }, requestId);
  }

  const incluirInactivos = new URL(request.url).searchParams.get('incluirInactivos') === '1';
  const placeholders = roleIdentity.allowedMarkets.map(() => '?').join(',');
  const rows = await query(
    env.DB, requestId,
    `SELECT id, nombre, mercado, estado FROM equipos WHERE mercado IN (${placeholders})${incluirInactivos ? '' : " AND estado = 'activo'"} ORDER BY mercado, nombre`,
    roleIdentity.allowedMarkets
  );

  return ok({ equipos: rows.map((e) => ({ id: e.id, nombre: e.nombre, mercado: e.mercado, estado: e.estado })) }, requestId);
}

async function handleCreate(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!roleIdentity.permissions.manageUsers) {
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
  const { nombre, mercado } = body || {};
  if (typeof nombre !== 'string' || !nombre.trim()) {
    return Errors.validation('Falta el nombre del equipo.', requestId);
  }
  if (!VALID_MERCADOS.includes(mercado)) {
    return Errors.validation('Mercado inválido.', requestId);
  }

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    'INSERT INTO equipos (id, nombre, mercado, created_by) VALUES (?, ?, ?, ?)',
    [id, nombre.trim(), mercado, roleIdentity.email]
  );
  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'equipo', entidadId: id, estadoAnterior: null, estadoNuevo: 'creado',
    usuarioEmail: roleIdentity.email, motivoNota: `Equipo "${nombre.trim()}" (${mercado}) creado desde el Panel Administrativo.`,
  });

  return ok({ id, nombre: nombre.trim(), mercado, estado: 'activo' }, requestId, 201);
}
