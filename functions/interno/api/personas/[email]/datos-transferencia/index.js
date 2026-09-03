// GET/POST /interno/api/personas/:email/datos-transferencia — RIO-119
// (tercer bloque — datos de transferencia protegidos, 02/09/2026).
// Exclusivo de administración (permissions.manageUsers) — un supervisor,
// vendedor o asistente recibe 403 sin excepción.
//
// GET: lista SIEMPRE enmascarada (nunca descifra) — banco/tipo de cuenta/
// tipo de documento/moneda/país son metadatos categóricos, no
// identificadores, y viajan tal cual; titular/identificación/número de
// cuenta/alias/observaciones son los campos cifrados y nunca se exponen
// acá, ni siquiera parcialmente.
//
// POST: crea un registro nuevo — cada campo sensible se cifra
// (functions/_shared/crypto.js, AES-GCM) antes de escribir en D1. Nunca se
// guardan contraseñas, PIN, tokens bancarios, códigos de seguridad ni
// claves dinámicas — esos campos ni siquiera existen en este esquema.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query, execute } from '../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../_shared/security.js';
import { logEvento } from '../../../../../_shared/historial.js';
import { encryptField, CryptoConfigError, MASKED_PLACEHOLDER } from '../../../../../_shared/crypto.js';

const VALID_PAISES = ['CL', 'AR'];
const VALID_MONEDAS = ['CLP', 'ARS'];

function serializeMasked(row) {
  return {
    id: row.id,
    pais: row.pais,
    moneda: row.moneda,
    bancoProveedor: row.banco_proveedor,
    tipoCuenta: row.tipo_cuenta || null,
    tipoDocumento: row.tipo_documento || null,
    // Campos cifrados: nunca se descifran acá — solo se informa si hay un
    // valor cargado, con el mismo placeholder genérico siempre.
    titular: row.titular_cifrado ? MASKED_PLACEHOLDER : null,
    identificacion: row.identificacion_cifrada ? MASKED_PLACEHOLDER : null,
    numeroCuenta: row.numero_cuenta_cifrado ? MASKED_PLACEHOLDER : null,
    alias: row.alias_cifrado ? MASKED_PLACEHOLDER : null,
    observaciones: row.observaciones_cifradas ? MASKED_PLACEHOLDER : null,
    estado: row.estado,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const email = decodeURIComponent(params.email || '').trim().toLowerCase();
  const usuarioRows = await query(env.DB, requestId, 'SELECT id FROM usuarios WHERE email = ?', [email]);
  if (!usuarioRows[0]) return Errors.notFound(requestId);

  if (request.method === 'GET') {
    const rows = await query(
      env.DB, requestId,
      "SELECT * FROM datos_transferencia WHERE usuario_email = ? AND estado = 'activo' ORDER BY created_at DESC",
      [email]
    );
    return ok({ datosTransferencia: rows.map(serializeMasked) }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const { pais, moneda, bancoProveedor, tipoCuenta, tipoDocumento, titular, identificacion, numeroCuenta, alias, observaciones } = body || {};
  if (!VALID_PAISES.includes(pais)) return Errors.validation('País inválido.', requestId);
  if (!VALID_MONEDAS.includes(moneda)) return Errors.validation('Moneda inválida.', requestId);
  if (typeof bancoProveedor !== 'string' || !bancoProveedor.trim()) {
    return Errors.validation('Falta el banco o proveedor.', requestId);
  }

  let titularCifrado, identificacionCifrada, numeroCuentaCifrado, aliasCifrado, observacionesCifradas;
  try {
    titularCifrado = await encryptField(env, titular);
    identificacionCifrada = await encryptField(env, identificacion);
    numeroCuentaCifrado = await encryptField(env, numeroCuenta);
    aliasCifrado = await encryptField(env, alias);
    observacionesCifradas = await encryptField(env, observaciones);
  } catch (e) {
    if (e instanceof CryptoConfigError) return Errors.internal(requestId);
    throw e;
  }

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    `INSERT INTO datos_transferencia (
       id, usuario_email, pais, moneda, banco_proveedor, tipo_cuenta, tipo_documento,
       titular_cifrado, identificacion_cifrada, numero_cuenta_cifrado, alias_cifrado, observaciones_cifradas, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, email, pais, moneda, bancoProveedor.trim(), (tipoCuenta && tipoCuenta.trim()) || null, (tipoDocumento && tipoDocumento.trim()) || null,
      titularCifrado, identificacionCifrada, numeroCuentaCifrado, aliasCifrado, observacionesCifradas, roleIdentity.email,
    ]
  );
  // Nunca el valor — solo el hecho de que se creó un registro.
  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'usuario', entidadId: email, estadoAnterior: null, estadoNuevo: 'datos_transferencia_creados',
    usuarioEmail: roleIdentity.email, motivoNota: `Registro de transferencia creado (${pais}/${moneda}, id ${id}).`,
  });

  return ok({ id }, requestId, 201);
}
