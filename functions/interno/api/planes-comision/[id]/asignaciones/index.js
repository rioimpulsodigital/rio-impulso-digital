// GET/POST /interno/api/planes-comision/:id/asignaciones — RIO-119 (tercer
// bloque, item 3, 02/09/2026). Exclusivo de administración.
//
// Asigna un plan (definición) a una persona concreta, con vigencia
// (`validFrom`/`validUntil`) — mismo patrón que `asignaciones_rol` y
// `equipo_supervisores`. `resolverAsignacionVigente` (_shared/comisiones.js)
// es quien realmente usa esto al generar una comisión: sin asignación
// vigente que además alcance el producto/mercado de la venta, no hay
// comisión (nunca inventada). Cambiar la vigencia acá NUNCA recalcula
// comisiones ya generadas (snapshot inmutable).
//
// GET: todas las asignaciones de este plan (vigentes y vencidas — "consultar
// versiones anteriores").
// POST: 'asignar' (usuarioEmail, validFrom opcional — default ahora,
//   validUntil opcional — default sin fecha de fin, note opcional). 'cerrar'
//   (id de la asignación) — cierra la vigencia, nunca borra la fila.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query, execute } from '../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../_shared/security.js';
import { logEvento } from '../../../../../_shared/historial.js';

function serializeAsignacion(row) {
  return {
    id: row.id,
    usuarioEmail: row.usuario_email,
    usuarioNombre: row.usuario_nombre || null,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    note: row.note || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const planRows = await query(env.DB, requestId, 'SELECT id FROM planes_comision WHERE id = ?', [params.id]);
  if (!planRows[0]) return Errors.notFound(requestId);

  if (request.method === 'GET') {
    const rows = await query(
      env.DB, requestId,
      `SELECT a.id, a.valid_from, a.valid_until, a.note, a.created_by, a.created_at, u.email AS usuario_email, u.nombre AS usuario_nombre
       FROM asignaciones_plan_comision a JOIN usuarios u ON u.id = a.usuario_id
       WHERE a.plan_id = ? ORDER BY a.valid_from DESC`,
      [params.id]
    );
    return ok({ asignaciones: rows.map(serializeAsignacion) }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action === 'asignar') {
    const usuarioEmail = typeof body.usuarioEmail === 'string' ? body.usuarioEmail.trim().toLowerCase() : '';
    if (!usuarioEmail) return Errors.validation('Falta usuarioEmail.', requestId);
    if (body.validFrom !== undefined && typeof body.validFrom !== 'string') return Errors.validation('validFrom inválido.', requestId);
    if (body.validUntil !== undefined && body.validUntil !== null && typeof body.validUntil !== 'string') return Errors.validation('validUntil inválido.', requestId);

    const usuarioRows = await query(env.DB, requestId, 'SELECT id FROM usuarios WHERE email = ?', [usuarioEmail]);
    const usuario = usuarioRows[0];
    if (!usuario) return Errors.validation('No existe una persona con ese correo.', requestId);

    const id = crypto.randomUUID();
    const columnas = ['id', 'usuario_id', 'plan_id', 'created_by'];
    const valores = [id, usuario.id, params.id, roleIdentity.email];
    if (body.validFrom) { columnas.push('valid_from'); valores.push(body.validFrom); }
    if (body.validUntil) { columnas.push('valid_until'); valores.push(body.validUntil); }
    if (body.note) { columnas.push('note'); valores.push(body.note); }

    await execute(
      env.DB, requestId,
      `INSERT INTO asignaciones_plan_comision (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
      valores
    );
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'asignacion_plan_comision', entidadId: id, estadoAnterior: null, estadoNuevo: 'creada',
      usuarioEmail: roleIdentity.email, motivoNota: `Plan ${params.id} asignado a ${usuarioEmail}.`,
    });
    return ok({ id }, requestId, 201);
  }

  if (body?.action === 'cerrar') {
    if (!body.id) return Errors.validation('Falta id de la asignación.', requestId);
    const asigRows = await query(env.DB, requestId, 'SELECT id, valid_until FROM asignaciones_plan_comision WHERE id = ? AND plan_id = ?', [body.id, params.id]);
    const asignacion = asigRows[0];
    if (!asignacion) return Errors.notFound(requestId);
    if (asignacion.valid_until) return Errors.validation('Esa asignación ya está cerrada.', requestId);

    await execute(env.DB, requestId, "UPDATE asignaciones_plan_comision SET valid_until = datetime('now') WHERE id = ?", [asignacion.id]);
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'asignacion_plan_comision', entidadId: asignacion.id, estadoAnterior: 'vigente', estadoNuevo: 'cerrada',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || 'Asignación cerrada.',
    });
    return ok({ id: asignacion.id }, requestId);
  }

  return Errors.validation('action inválida. Valores permitidos: asignar, cerrar.', requestId);
}
