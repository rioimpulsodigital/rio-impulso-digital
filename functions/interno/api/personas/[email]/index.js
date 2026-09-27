// POST /interno/api/personas/:email — RIO-119 (segundo bloque, 02/09/2026;
// tercer bloque — identidad estable y RUT/DNI protegido, 02/09/2026).
// Exclusivo de administración (permissions.manageUsers).
//
// action 'editar-perfil': nombre/documentoIdentidad/telefono/
//   whatsappLaboral/accesoEstado — edición directa (no versionada), pero
//   siempre auditada. El documento se guarda CIFRADO (crypto.js) — el
//   registro de auditoría nunca contiene el texto plano, solo si había o
//   no un valor y si cambió.
// action 'revelar-documento': descifra y devuelve el RUT/DNI UNA vez —
//   nunca en el listado ni en el perfil por defecto. Auditado (queda
//   registrado QUIÉN reveló y CUÁNDO, nunca el valor en el propio evento).
// action 'cambiar-asignacion': role/allowedMarkets/defaultMarket/canSell/
//   userStatus — SIEMPRE una fila nueva versionada; la vigente anterior se
//   cierra con valid_until, nunca se sobrescribe.
// action 'cambiar-correo': identidad estable — el correo es el valor que
//   hoy funciona como clave real en casi todo el sistema (RIO-118: "una
//   migración mayor a usuario_id, fuera de proporción"), así que en vez de
//   reescribir todo el modelo a FKs numéricas, esta acción CASCADEA el
//   cambio atómicamente a cada tabla de identidad VIGENTE (nunca a
//   eventos_historial ni a ningún snapshot histórico deliberado, como
//   ventas.supervisor_snapshot_email — esos representan un hecho "tal como
//   era en ese momento", no la identidad actual) — así ninguna venta,
//   equipo, comisión, liquidación o entrega queda huérfana. Registra el
//   cambio en usuarios_correos_historicos y en eventos_historial.

import { ok, Errors } from '../../../../_shared/response.js';
import { query, execute, transaction } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { logEvento } from '../../../../_shared/historial.js';
import { encryptField, decryptField, CryptoConfigError } from '../../../../_shared/crypto.js';

const VALID_ROLES = ['admin', 'supervisor', 'ejecutivo', 'asistente'];
const VALID_MERCADOS = ['CL', 'AR'];
const VALID_ACCESO_ESTADO = ['perfil_creado', 'acceso_pendiente', 'acceso_confirmado', 'desactivado'];
const VALID_USER_STATUS = ['activo', 'inactivo'];

// RIO-119 (identidad estable, confirmado explícitamente 03/09/2026):
// `usuarios.id` (INTEGER PRIMARY KEY AUTOINCREMENT) es el ID INTERNO
// CANÓNICO E INMUTABLE de cada persona — asignado una sola vez al crear el
// perfil, nunca reasignado ni reescrito por ninguna acción de este
// endpoint (la acción 'cambiar-correo' de abajo actualiza únicamente la
// columna `email`, jamás `id`). El correo es la identidad de ACCESO
// (cambia, y su cambio queda auditado en `usuarios_correos_historicos`),
// nunca la identidad histórica principal del sistema.
//
// Hoy, ventas/comisiones/equipos/historial NO referencian usuario_id
// directamente — usan el correo como puntero de identidad vigente,
// mantenido en sincronía atómica por la cascada de abajo (nunca diverge
// en silencio). La única tabla que sí referencia `usuarios.id`
// directamente es `asignaciones_plan_comision.usuario_id` (planes de
// comisión, RIO-119 tercer bloque). Migrar el resto del esquema a
// usuario_id fue evaluado en RIO-118 y descartado por desproporcionado
// para el alcance actual — la cascada de correo cumple la misma garantía
// (ningún cambio de correo rompe ventas/equipos/comisiones/historial)
// sin esa reescritura mayor.
//
// Tablas donde el correo representa la identidad VIGENTE de una persona —
// se cascadea al cambiar de correo. Cada entrada: [tabla, columna].
const TABLAS_IDENTIDAD_VIGENTE = [
  ['ventas', 'vendedor_email'],
  ['comisiones', 'beneficiario_email'],
  ['transferencias_comision', 'beneficiario_email'],
  ['equipo_miembros', 'usuario_email'],
  ['equipo_supervisores', 'usuario_email'],
  ['asignaciones_realizacion', 'usuario_email'],
  ['materiales_informados_detalle', 'informado_por'],
  ['materiales_informados_detalle', 'revisado_por'],
  ['materiales_confirmaciones', 'admin_email'],
  ['notificaciones', 'vendedor_email'],
  ['datos_transferencia', 'usuario_email'],
];

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

    const nombreFinal = nombre !== undefined ? nombre.trim() : usuario.nombre;
    const telefonoFinal = telefono !== undefined ? ((telefono && telefono.trim()) || null) : usuario.telefono;
    const whatsappFinal = whatsappLaboral !== undefined ? ((whatsappLaboral && whatsappLaboral.trim()) || null) : usuario.whatsapp_laboral;
    const accesoFinal = accesoEstado !== undefined ? accesoEstado : usuario.acceso_estado;

    let documentoFinal = usuario.documento_identidad;
    let documentoCambio = false;
    if (documentoIdentidad !== undefined) {
      documentoCambio = true;
      try {
        documentoFinal = await encryptField(env, documentoIdentidad && documentoIdentidad.trim());
      } catch (e) {
        if (e instanceof CryptoConfigError) return Errors.internal(requestId);
        throw e;
      }
    }

    // Se calcula ANTES de escribir — nunca depender de que el objeto
    // `usuario` leído al principio de la función siga reflejando el valor
    // previo después de la escritura (defensivo, aunque D1 real ya
    // devuelve filas independientes, no una referencia viva).
    // RIO-119 (tercer bloque): el RUT/DNI NUNCA aparece en el historial, ni
    // el anterior ni el nuevo — solo si el campo cambió (booleano).
    const valorAnterior = JSON.stringify({ nombre: usuario.nombre, telefono: usuario.telefono, whatsappLaboral: usuario.whatsapp_laboral, accesoEstado: usuario.acceso_estado });
    const valorNuevo = JSON.stringify({ nombre: nombreFinal, telefono: telefonoFinal, whatsappLaboral: whatsappFinal, accesoEstado: accesoFinal, documentoIdentidadCambiado: documentoCambio });

    await execute(
      env.DB, requestId,
      'UPDATE usuarios SET nombre = ?, documento_identidad = ?, telefono = ?, whatsapp_laboral = ?, acceso_estado = ? WHERE id = ?',
      [nombreFinal, documentoFinal, telefonoFinal, whatsappFinal, accesoFinal, usuario.id]
    );
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'usuario', entidadId: email, estadoAnterior: valorAnterior, estadoNuevo: valorNuevo,
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || null,
    });
    return ok({ action: 'editar-perfil' }, requestId);
  }

  if (body?.action === 'revelar-documento') {
    if (!usuario.documento_identidad) {
      return ok({ action: 'revelar-documento', documentoIdentidad: null }, requestId);
    }
    let documentoPlano;
    try {
      documentoPlano = await decryptField(env, usuario.documento_identidad);
    } catch (e) {
      if (e instanceof CryptoConfigError) return Errors.internal(requestId);
      throw e;
    }
    // Auditado — nunca el valor revelado, solo el hecho y quién lo pidió.
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'usuario', entidadId: email, estadoAnterior: null, estadoNuevo: 'documento_revelado',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || null,
    });
    return ok({ action: 'revelar-documento', documentoIdentidad: documentoPlano }, requestId);
  }

  if (body?.action === 'cambiar-asignacion') {
    const { role, allowedMarkets, defaultMarket, canSell, canReceiveCommissionAdvance, userStatus, motivo } = body;
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
      `SELECT id, role, allowed_markets, can_sell, can_receive_commission_advance, user_status FROM asignaciones_rol
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
      'INSERT INTO asignaciones_rol (usuario_id, role, allowed_markets, default_market, can_sell, can_receive_commission_advance, user_status, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [usuario.id, role, JSON.stringify(allowedMarkets), defaultMarket || allowedMarkets[0], canSell ? 1 : 0, canReceiveCommissionAdvance ? 1 : 0, userStatus || 'activo', motivo || null, roleIdentity.email]
    );

    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'asignacion_rol', entidadId: email,
      estadoAnterior: vigente ? JSON.stringify({ role: vigente.role, allowedMarkets: JSON.parse(vigente.allowed_markets), canSell: !!vigente.can_sell, canReceiveCommissionAdvance: !!vigente.can_receive_commission_advance, userStatus: vigente.user_status }) : null,
      estadoNuevo: JSON.stringify({ role, allowedMarkets, canSell: !!canSell, canReceiveCommissionAdvance: !!canReceiveCommissionAdvance, userStatus: userStatus || 'activo' }),
      usuarioEmail: roleIdentity.email, motivoNota: motivo || null,
    });
    return ok({ action: 'cambiar-asignacion' }, requestId);
  }

  if (body?.action === 'cambiar-correo') {
    const nuevoEmail = typeof body.nuevoEmail === 'string' ? body.nuevoEmail.trim().toLowerCase() : '';
    if (!nuevoEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nuevoEmail)) {
      return Errors.validation('Falta un nuevoEmail válido.', requestId);
    }
    if (nuevoEmail === email) {
      return Errors.validation('El nuevo correo debe ser distinto al actual.', requestId);
    }
    const yaExiste = await query(env.DB, requestId, 'SELECT id FROM usuarios WHERE email = ?', [nuevoEmail]);
    if (yaExiste[0]) {
      return Errors.validation('Ya existe otro usuario con ese correo.', requestId);
    }

    const statements = [
      env.DB.prepare('UPDATE usuarios SET email = ? WHERE id = ?').bind(nuevoEmail, usuario.id),
      ...TABLAS_IDENTIDAD_VIGENTE.map(([tabla, columna]) =>
        env.DB.prepare(`UPDATE ${tabla} SET ${columna} = ? WHERE ${columna} = ?`).bind(nuevoEmail, email)
      ),
      env.DB.prepare('INSERT INTO usuarios_correos_historicos (id, usuario_id, correo_anterior, correo_nuevo, changed_by) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), usuario.id, email, nuevoEmail, roleIdentity.email),
    ];
    try {
      await transaction(env.DB, requestId, statements);
    } catch (e) {
      return Errors.internal(requestId);
    }

    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'usuario', entidadId: nuevoEmail, estadoAnterior: email, estadoNuevo: nuevoEmail,
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || 'Cambio de correo — todas las relaciones vigentes se actualizaron en la misma operación.',
    });
    return ok({ action: 'cambiar-correo', email: nuevoEmail }, requestId);
  }

  return Errors.validation('action inválida. Valores permitidos: editar-perfil, revelar-documento, cambiar-asignacion, cambiar-correo.', requestId);
}
