// GET/POST /interno/api/equipos/:id/miembros — RIO-119 (segundo bloque,
// 02/09/2026). Exclusivo de administración.
//
// GET: miembros VIGENTES del equipo, con nombre resuelto desde D1.
// POST: action 'agregar' (usuarioEmail) inserta una nueva fila vigente;
// 'quitar' (usuarioEmail) cierra la fila vigente de esa persona con
// valid_until — NUNCA se borra una fila, mismo criterio de versionado que
// ya rige equipo_supervisores/asignaciones_rol/planes_comision desde
// RIO-115/118.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query, execute } from '../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../_shared/security.js';
import { logEvento } from '../../../../../_shared/historial.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const equipoRows = await query(env.DB, requestId, 'SELECT id FROM equipos WHERE id = ?', [params.id]);
  if (!equipoRows[0]) return Errors.notFound(requestId);

  if (request.method === 'GET') {
    const rows = await query(
      env.DB, requestId,
      `SELECT m.id, m.usuario_email, m.valid_from, u.nombre AS usuario_nombre
       FROM equipo_miembros m LEFT JOIN usuarios u ON u.email = m.usuario_email
       WHERE m.equipo_id = ? AND (m.valid_until IS NULL OR m.valid_until > datetime('now')) AND m.valid_from <= datetime('now')
       ORDER BY u.nombre ASC`,
      [params.id]
    );
    return ok({ miembros: rows.map((r) => ({ id: r.id, usuarioEmail: r.usuario_email, usuarioNombre: r.usuario_nombre || null, validFrom: r.valid_from })) }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  const usuarioEmail = typeof body?.usuarioEmail === 'string' ? body.usuarioEmail.trim().toLowerCase() : '';
  if (!usuarioEmail) return Errors.validation('Falta usuarioEmail.', requestId);

  if (body.action === 'agregar') {
    const existente = await query(
      env.DB, requestId,
      `SELECT id FROM equipo_miembros WHERE equipo_id = ? AND usuario_email = ? AND (valid_until IS NULL OR valid_until > datetime('now'))`,
      [params.id, usuarioEmail]
    );
    if (existente[0]) return Errors.validation('Esa persona ya es miembro vigente de este equipo.', requestId);

    const id = crypto.randomUUID();
    await execute(env.DB, requestId, 'INSERT INTO equipo_miembros (id, equipo_id, usuario_email, created_by) VALUES (?, ?, ?, ?)', [id, params.id, usuarioEmail, roleIdentity.email]);
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'equipo_miembro', entidadId: id, estadoAnterior: null, estadoNuevo: 'agregado',
      usuarioEmail: roleIdentity.email, motivoNota: `${usuarioEmail} agregado al equipo ${params.id}.`,
    });
    return ok({ id, usuarioEmail }, requestId, 201);
  }

  if (body.action === 'quitar') {
    const vigenteRows = await query(
      env.DB, requestId,
      `SELECT id FROM equipo_miembros WHERE equipo_id = ? AND usuario_email = ? AND (valid_until IS NULL OR valid_until > datetime('now')) AND valid_from <= datetime('now')
       ORDER BY valid_from DESC LIMIT 1`,
      [params.id, usuarioEmail]
    );
    const vigente = vigenteRows[0];
    if (!vigente) return Errors.notFound(requestId);

    await execute(env.DB, requestId, "UPDATE equipo_miembros SET valid_until = datetime('now') WHERE id = ?", [vigente.id]);
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'equipo_miembro', entidadId: vigente.id, estadoAnterior: 'vigente', estadoNuevo: 'cerrado',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || `${usuarioEmail} quitado del equipo ${params.id}.`,
    });
    return ok({ id: vigente.id }, requestId);
  }

  return Errors.validation('action inválida. Valores permitidos: agregar, quitar.', requestId);
}
