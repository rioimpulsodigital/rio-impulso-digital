// GET/POST /interno/api/equipos/:id/supervisores — RIO-119 (segundo
// bloque, 02/09/2026). Exclusivo de administración.
//
// GET: supervisores VIGENTES del equipo, con nombre y cuál es el
// principal (RIO-118: referente de contacto en "Mi referente comercial").
// POST: 'agregar' (usuarioEmail, esPrincipal opcional) — un equipo puede
// tener MÁS de un supervisor vigente a la vez (Brenda, 02/09/2026: "en el
// futuro, varios supervisores"), pero como máximo UNO principal — agregar
// uno como principal desmarca automáticamente al anterior, nunca deja dos
// a la vez. 'quitar' cierra la fila vigente. 'marcar-principal' cambia
// cuál es el principal sin tocar la vigencia de ninguno.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query, execute } from '../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../_shared/security.js';
import { logEvento } from '../../../../../_shared/historial.js';

async function limpiarPrincipalVigente(db, requestId, equipoId) {
  await execute(db, requestId, "UPDATE equipo_supervisores SET es_principal = 0 WHERE equipo_id = ? AND (valid_until IS NULL OR valid_until > datetime('now'))", [equipoId]);
}

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
      `SELECT s.id, s.usuario_email, s.valid_from, s.es_principal, u.nombre AS usuario_nombre
       FROM equipo_supervisores s LEFT JOIN usuarios u ON u.email = s.usuario_email
       WHERE s.equipo_id = ? AND (s.valid_until IS NULL OR s.valid_until > datetime('now')) AND s.valid_from <= datetime('now')
       ORDER BY s.es_principal DESC, u.nombre ASC`,
      [params.id]
    );
    return ok({ supervisores: rows.map((r) => ({ id: r.id, usuarioEmail: r.usuario_email, usuarioNombre: r.usuario_nombre || null, validFrom: r.valid_from, esPrincipal: !!r.es_principal })) }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  const usuarioEmail = typeof body?.usuarioEmail === 'string' ? body.usuarioEmail.trim().toLowerCase() : '';
  if (!usuarioEmail && body?.action !== undefined) return Errors.validation('Falta usuarioEmail.', requestId);

  if (body.action === 'agregar') {
    const existente = await query(
      env.DB, requestId,
      `SELECT id FROM equipo_supervisores WHERE equipo_id = ? AND usuario_email = ? AND (valid_until IS NULL OR valid_until > datetime('now'))`,
      [params.id, usuarioEmail]
    );
    if (existente[0]) return Errors.validation('Esa persona ya es supervisora vigente de este equipo.', requestId);

    const esPrincipal = body.esPrincipal === true;
    if (esPrincipal) await limpiarPrincipalVigente(env.DB, requestId, params.id);

    const id = crypto.randomUUID();
    await execute(
      env.DB, requestId,
      'INSERT INTO equipo_supervisores (id, equipo_id, usuario_email, es_principal, created_by) VALUES (?, ?, ?, ?, ?)',
      [id, params.id, usuarioEmail, esPrincipal ? 1 : 0, roleIdentity.email]
    );
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'equipo_supervisor', entidadId: id, estadoAnterior: null, estadoNuevo: esPrincipal ? 'agregado_principal' : 'agregado',
      usuarioEmail: roleIdentity.email, motivoNota: `${usuarioEmail} agregado como supervisor del equipo ${params.id}.`,
    });
    return ok({ id, usuarioEmail, esPrincipal }, requestId, 201);
  }

  if (body.action === 'quitar') {
    const vigenteRows = await query(
      env.DB, requestId,
      `SELECT id FROM equipo_supervisores WHERE equipo_id = ? AND usuario_email = ? AND (valid_until IS NULL OR valid_until > datetime('now')) AND valid_from <= datetime('now')
       ORDER BY valid_from DESC LIMIT 1`,
      [params.id, usuarioEmail]
    );
    const vigente = vigenteRows[0];
    if (!vigente) return Errors.notFound(requestId);

    await execute(env.DB, requestId, "UPDATE equipo_supervisores SET valid_until = datetime('now') WHERE id = ?", [vigente.id]);
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'equipo_supervisor', entidadId: vigente.id, estadoAnterior: 'vigente', estadoNuevo: 'cerrado',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || `${usuarioEmail} quitado como supervisor del equipo ${params.id}.`,
    });
    return ok({ id: vigente.id }, requestId);
  }

  if (body.action === 'marcar-principal') {
    const vigenteRows = await query(
      env.DB, requestId,
      `SELECT id FROM equipo_supervisores WHERE equipo_id = ? AND usuario_email = ? AND (valid_until IS NULL OR valid_until > datetime('now')) AND valid_from <= datetime('now')
       ORDER BY valid_from DESC LIMIT 1`,
      [params.id, usuarioEmail]
    );
    const vigente = vigenteRows[0];
    if (!vigente) return Errors.notFound(requestId);

    await limpiarPrincipalVigente(env.DB, requestId, params.id);
    await execute(env.DB, requestId, 'UPDATE equipo_supervisores SET es_principal = 1 WHERE id = ?', [vigente.id]);
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'equipo_supervisor', entidadId: vigente.id, estadoAnterior: 'no_principal', estadoNuevo: 'principal',
      usuarioEmail: roleIdentity.email, motivoNota: `${usuarioEmail} marcado como supervisor principal del equipo ${params.id}.`,
    });
    return ok({ id: vigente.id, esPrincipal: true }, requestId);
  }

  return Errors.validation('action inválida. Valores permitidos: agregar, quitar, marcar-principal.', requestId);
}
