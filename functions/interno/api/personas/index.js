// GET/POST /interno/api/personas — RIO-119 (segundo bloque —
// administración de personas y equipos, 02/09/2026). Exclusivo de
// administración (permissions.manageUsers).
//
// GET: a diferencia de /interno/api/identidad/usuarios (RIO-111, que solo
// lista a quienes tienen una asignación de rol VIGENTE), este LEFT JOIN
// nunca pierde de la lista a un perfil recién creado sin rol asignado
// todavía, ni a alguien con solo asignaciones ya cerradas — administración
// necesita verlos igual para poder asignarles un rol.
//
// POST: crea un usuario nuevo + su primera asignación de rol. No es
// atómico entre las dos tablas (usuarios.id es autoincremental, se
// necesita conocerlo antes de insertar la asignación) — si la segunda
// escritura fallara, el perfil queda creado igual y se completa después
// con 'cambiar-asignacion' (mismo criterio que el resto del sistema: una
// consecuencia administrativa nunca bloquea el dato principal ya creado).

import { ok, Errors } from '../../../_shared/response.js';
import { query, execute } from '../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../_shared/security.js';
import { logEvento } from '../../../_shared/historial.js';
import { encryptField, CryptoConfigError } from '../../../_shared/crypto.js';

const VALID_ROLES = ['admin', 'supervisor', 'ejecutivo', 'asistente'];
const VALID_MERCADOS = ['CL', 'AR'];

// RIO-119 (tercer bloque — RUT/DNI protegido, 02/09/2026): el documento se
// guarda cifrado (functions/_shared/crypto.js) — este listado NUNCA expone
// el valor, ni siquiera parcial. Solo dice si hay uno cargado; el valor
// real se obtiene exclusivamente con la acción 'revelar-documento'
// (personas/[email]/index.js), exclusiva de administración y auditada.
function serializePersona(row) {
  return {
    email: row.email,
    nombre: row.nombre,
    tieneDocumento: !!row.documento_identidad,
    telefono: row.telefono || null,
    whatsappLaboral: row.whatsapp_laboral || null,
    accesoEstado: row.acceso_estado,
    role: row.role || null,
    allowedMarkets: row.allowed_markets ? JSON.parse(row.allowed_markets) : [],
    defaultMarket: row.default_market || null,
    canSell: !!row.can_sell,
    userStatus: row.user_status || null,
    validFrom: row.valid_from || null,
    createdAt: row.created_at,
  };
}

export async function onRequest(context) {
  const { request } = context;
  if (!isMethodAllowed(request, ['GET', 'POST'])) {
    return Errors.methodNotAllowed(context.data.requestId);
  }
  return request.method === 'GET' ? handleList(context) : handleCreate(context);
}

async function handleList(context) {
  const { env, data } = context;
  const { requestId, roleIdentity } = data;
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const rows = await query(
    env.DB, requestId,
    `SELECT u.email, u.nombre, u.documento_identidad, u.telefono, u.whatsapp_laboral, u.acceso_estado, u.created_at,
       a.role, a.allowed_markets, a.default_market, a.can_sell, a.user_status, a.valid_from
     FROM usuarios u
     LEFT JOIN asignaciones_rol a ON a.usuario_id = u.id
       AND (a.valid_until IS NULL OR a.valid_until > datetime('now')) AND a.valid_from <= datetime('now')
     ORDER BY u.nombre ASC`
  );
  return ok({ personas: rows.map(serializePersona) }, requestId);
}

async function handleCreate(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const { email, nombre, role, allowedMarkets, defaultMarket, canSell, documentoIdentidad, telefono, whatsappLaboral } = body || {};
  const emailNorm = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    return Errors.validation('Falta un email válido.', requestId);
  }
  if (typeof nombre !== 'string' || !nombre.trim()) {
    return Errors.validation('Falta el nombre.', requestId);
  }
  if (!VALID_ROLES.includes(role)) {
    return Errors.validation('Rol inválido.', requestId);
  }
  if (!Array.isArray(allowedMarkets) || allowedMarkets.length === 0 || !allowedMarkets.every((m) => VALID_MERCADOS.includes(m))) {
    return Errors.validation('allowedMarkets debe ser un array no vacío de mercados válidos.', requestId);
  }
  if (defaultMarket !== undefined && defaultMarket !== null && !allowedMarkets.includes(defaultMarket)) {
    return Errors.validation('defaultMarket debe estar entre los mercados autorizados.', requestId);
  }

  const existente = await query(env.DB, requestId, 'SELECT id FROM usuarios WHERE email = ?', [emailNorm]);
  if (existente[0]) {
    return Errors.validation('Ya existe un usuario con ese email.', requestId);
  }

  let documentoCifrado;
  try {
    documentoCifrado = await encryptField(env, documentoIdentidad && documentoIdentidad.trim());
  } catch (e) {
    if (e instanceof CryptoConfigError) return Errors.internal(requestId); // secreto de cifrado no configurado — nunca se guarda sin cifrar.
    throw e;
  }

  await execute(
    env.DB, requestId,
    'INSERT INTO usuarios (email, nombre, documento_identidad, telefono, whatsapp_laboral) VALUES (?, ?, ?, ?, ?)',
    [emailNorm, nombre.trim(), documentoCifrado, (telefono && telefono.trim()) || null, (whatsappLaboral && whatsappLaboral.trim()) || null]
  );
  const usuarioRows = await query(env.DB, requestId, 'SELECT id FROM usuarios WHERE email = ?', [emailNorm]);
  const usuarioId = usuarioRows[0].id;

  await execute(
    env.DB, requestId,
    'INSERT INTO asignaciones_rol (usuario_id, role, allowed_markets, default_market, can_sell, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [usuarioId, role, JSON.stringify(allowedMarkets), defaultMarket || allowedMarkets[0], canSell ? 1 : 0, roleIdentity.email]
  );

  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'usuario', entidadId: emailNorm, estadoAnterior: null, estadoNuevo: 'creado',
    usuarioEmail: roleIdentity.email, motivoNota: 'Perfil creado desde el Panel Administrativo.',
  });
  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'asignacion_rol', entidadId: emailNorm, estadoAnterior: null,
    estadoNuevo: JSON.stringify({ role, allowedMarkets, canSell: !!canSell }),
    usuarioEmail: roleIdentity.email, motivoNota: 'Asignación inicial al crear el perfil.',
  });

  return ok({ email: emailNorm }, requestId, 201);
}
