// POST /interno/api/personas/:email — RIO-119 (segundo bloque, 02/09/2026).
// Exclusivo de administración (permissions.manageUsers).
//
// action 'editar-perfil': nombre/documentoIdentidad/telefono/
//   whatsappLaboral/accesoEstado — edición directa (no versionada), pero
//   siempre auditada (valor anterior y nuevo completos en eventos_historial).
// action 'cambiar-asignacion': role/allowedMarkets/defaultMarket/canSell/
//   userStatus — SIEMPRE una fila nueva versionada; la vigente anterior se
//   cierra con valid_until, nunca se sobrescribe (mismo criterio que ya
//   rige equipo_supervisores/planes_comision desde RIO-115/118 — "nunca
//   retroactivo, siempre nueva versión").

import { ok, Errors } from '../../../../_shared/response.js';
import { query, execute } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { logEvento } from '../../../../_shared/historial.js';

const VALID_ROLES = ['admin', 'supervisor', 'ejecutivo', 'asistente'];
const VALID_MERCADOS = ['CL', 'AR'];
const VALID_ACCESO_ESTADO = ['perfil_creado', 'acceso_pendiente', 'acceso_confirmado', 'desactivado'];
const VALID_USER_STATUS = ['activo', 'inactivo'];

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  const email = decodeURIComponent(params.email || '').trim().toLowerCase();
  const usuarioRows = await query(
    env.DB, requestId,
    'SELECT id, nombre, documento_identidad, telefono, whatsapp_laboral, acceso_estado FROM usuarios WHERE email = ?',
    [email]
  );
  const usuario = usuarioRows[0];
  if (!usuario) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action === 'editar-perfil') {
    const { nombre, documentoIdentidad, telefono, whatsappLaboral, accesoEstado } = body;
    if (nombre !== undefined && (typeof nombre !== 'string' || !nombre.trim())) {
      return Errors.validation('nombre inválido.', requestId);
    }
    if (accesoEstado !== undefined && !VALID_ACCESO_ESTADO.includes(accesoEstado)) {
      return Errors.validation('accesoEstado inválido.', requestId);
    }

    const valorAnterior = JSON.stringify({
      nombre: usuario.nombre, documentoIdentidad: usuario.documento_identidad,
      telefono: usuario.telefono, whatsappLaboral: usuario.whatsapp_laboral, accesoEstado: usuario.acceso_estado,
    });
    const nombreFinal = nombre !== undefined ? nombre.trim() : usuario.nombre;
    const documentoFinal = documentoIdentidad !== undefined ? ((documentoIdentidad && documentoIdentidad.trim()) || null) : usuario.documento_identidad;
    const telefonoFinal = telefono !== undefined ? ((telefono && telefono.trim()) || null) : usuario.telefono;
    const whatsappFinal = whatsappLaboral !== undefined ? ((whatsappLaboral && whatsappLaboral.trim()) || null) : usuario.whatsapp_laboral;
    const accesoFinal = accesoEstado !== undefined ? accesoEstado : usuario.acceso_estado;

    await execute(
      env.DB, requestId,
      'UPDATE usuarios SET nombre = ?, documento_identidad = ?, telefono = ?, whatsapp_laboral = ?, acceso_estado = ? WHERE id = ?',
      [nombreFinal, documentoFinal, telefonoFinal, whatsappFinal, accesoFinal, usuario.id]
    );
    const valorNuevo = JSON.stringify({ nombre: nombreFinal, documentoIdentidad: documentoFinal, telefono: telefonoFinal, whatsappLaboral: whatsappFinal, accesoEstado: accesoFinal });
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'usuario', entidadId: email, estadoAnterior: valorAnterior, estadoNuevo: valorNuevo,
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || null,
    });
    return ok({ action: 'editar-perfil' }, requestId);
  }

  if (body?.action === 'cambiar-asignacion') {
    const { role, allowedMarkets, defaultMarket, canSell, userStatus, motivo } = body;
    if (!VALID_ROLES.includes(role)) return Errors.validation('Rol inválido.', requestId);
    if (!Array.isArray(allowedMarkets) || allowedMarkets.length === 0 || !allowedMarkets.every((m) => VALID_MERCADOS.includes(m))) {
      return Errors.validation('allowedMarkets debe ser un array no vacío de mercados válidos.', requestId);
    }
    if (defaultMarket !== undefined && defaultMarket !== null && !allowedMarkets.includes(defaultMarket)) {
      return Errors.validation('defaultMarket debe estar entre los mercados autorizados.', requestId);
    }
    if (userStatus !== undefined && !VALID_USER_STATUS.includes(userStatus)) {
      return Errors.validation('userStatus inválido.', requestId);
    }

    const vigenteRows = await query(
      env.DB, requestId,
      `SELECT id, role, allowed_markets, can_sell, user_status FROM asignaciones_rol
       WHERE usuario_id = ? AND (valid_until IS NULL OR valid_until > datetime('now')) AND valid_from <= datetime('now')
       ORDER BY valid_from DESC LIMIT 1`,
      [usuario.id]
    );
    const vigente = vigenteRows[0] || null;

    if (vigente) {
      await execute(env.DB, requestId, "UPDATE asignaciones_rol SET valid_until = datetime('now') WHERE id = ?", [vigente.id]);
    }
    await execute(
      env.DB, requestId,
      'INSERT INTO asignaciones_rol (usuario_id, role, allowed_markets, default_market, can_sell, user_status, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [usuario.id, role, JSON.stringify(allowedMarkets), defaultMarket || allowedMarkets[0], canSell ? 1 : 0, userStatus || 'activo', motivo || null, roleIdentity.email]
    );

    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'asignacion_rol', entidadId: email,
      estadoAnterior: vigente ? JSON.stringify({ role: vigente.role, allowedMarkets: JSON.parse(vigente.allowed_markets), canSell: !!vigente.can_sell, userStatus: vigente.user_status }) : null,
      estadoNuevo: JSON.stringify({ role, allowedMarkets, canSell: !!canSell, userStatus: userStatus || 'activo' }),
      usuarioEmail: roleIdentity.email, motivoNota: motivo || null,
    });
    return ok({ action: 'cambiar-asignacion' }, requestId);
  }

  return Errors.validation('action inválida. Valores permitidos: editar-perfil, cambiar-asignacion.', requestId);
}
