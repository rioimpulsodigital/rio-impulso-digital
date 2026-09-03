// POST /interno/api/personas/:email/datos-transferencia/:id — RIO-119
// (tercer bloque, 02/09/2026). Exclusivo de administración.
//
// action 'editar': reemplaza cualquier subconjunto de campos (cada uno
//   cifrado de nuevo si se envía) — auditado sin exponer valores.
// action 'eliminar': SOFT delete (estado='inactivo') — nunca se borra la
//   fila, mismo criterio de auditoría que el resto del sistema.
// action 'revelar': descifra TODOS los campos sensibles de este registro y
//   los devuelve UNA vez — auditado, nunca en el propio evento.

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query, execute } from '../../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';
import { logEvento } from '../../../../../../_shared/historial.js';
import { encryptField, decryptField, CryptoConfigError } from '../../../../../../_shared/crypto.js';

const VALID_PAISES = ['CL', 'AR'];
const VALID_MONEDAS = ['CLP', 'ARS'];

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  const email = decodeURIComponent(params.email || '').trim().toLowerCase();
  const rows = await query(env.DB, requestId, 'SELECT * FROM datos_transferencia WHERE id = ? AND usuario_email = ?', [params.id, email]);
  const registro = rows[0];
  if (!registro) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action === 'eliminar') {
    await execute(env.DB, requestId, "UPDATE datos_transferencia SET estado = 'inactivo', updated_by = ?, updated_at = datetime('now') WHERE id = ?", [roleIdentity.email, registro.id]);
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'usuario', entidadId: email, estadoAnterior: 'activo', estadoNuevo: 'datos_transferencia_eliminados',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || `Registro de transferencia ${registro.id} desactivado.`,
    });
    return ok({ action: 'eliminar' }, requestId);
  }

  if (body?.action === 'editar') {
    const { pais, moneda, bancoProveedor, tipoCuenta, tipoDocumento, titular, identificacion, numeroCuenta, alias, observaciones } = body;
    if (pais !== undefined && !VALID_PAISES.includes(pais)) return Errors.validation('País inválido.', requestId);
    if (moneda !== undefined && !VALID_MONEDAS.includes(moneda)) return Errors.validation('Moneda inválida.', requestId);
    if (bancoProveedor !== undefined && (typeof bancoProveedor !== 'string' || !bancoProveedor.trim())) {
      return Errors.validation('bancoProveedor inválido.', requestId);
    }

    let titularCifrado = registro.titular_cifrado;
    let identificacionCifrada = registro.identificacion_cifrada;
    let numeroCuentaCifrado = registro.numero_cuenta_cifrado;
    let aliasCifrado = registro.alias_cifrado;
    let observacionesCifradas = registro.observaciones_cifradas;
    try {
      if (titular !== undefined) titularCifrado = await encryptField(env, titular);
      if (identificacion !== undefined) identificacionCifrada = await encryptField(env, identificacion);
      if (numeroCuenta !== undefined) numeroCuentaCifrado = await encryptField(env, numeroCuenta);
      if (alias !== undefined) aliasCifrado = await encryptField(env, alias);
      if (observaciones !== undefined) observacionesCifradas = await encryptField(env, observaciones);
    } catch (e) {
      if (e instanceof CryptoConfigError) return Errors.internal(requestId);
      throw e;
    }

    await execute(
      env.DB, requestId,
      `UPDATE datos_transferencia SET
         pais = ?, moneda = ?, banco_proveedor = ?, tipo_cuenta = ?, tipo_documento = ?,
         titular_cifrado = ?, identificacion_cifrada = ?, numero_cuenta_cifrado = ?, alias_cifrado = ?, observaciones_cifradas = ?,
         updated_by = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        pais !== undefined ? pais : registro.pais,
        moneda !== undefined ? moneda : registro.moneda,
        bancoProveedor !== undefined ? bancoProveedor.trim() : registro.banco_proveedor,
        tipoCuenta !== undefined ? ((tipoCuenta && tipoCuenta.trim()) || null) : registro.tipo_cuenta,
        tipoDocumento !== undefined ? ((tipoDocumento && tipoDocumento.trim()) || null) : registro.tipo_documento,
        titularCifrado, identificacionCifrada, numeroCuentaCifrado, aliasCifrado, observacionesCifradas,
        roleIdentity.email, registro.id,
      ]
    );
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'usuario', entidadId: email, estadoAnterior: null, estadoNuevo: 'datos_transferencia_editados',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || `Registro de transferencia ${registro.id} editado.`,
    });
    return ok({ action: 'editar' }, requestId);
  }

  if (body?.action === 'revelar') {
    let plano;
    try {
      plano = {
        titular: await decryptField(env, registro.titular_cifrado),
        identificacion: await decryptField(env, registro.identificacion_cifrada),
        numeroCuenta: await decryptField(env, registro.numero_cuenta_cifrado),
        alias: await decryptField(env, registro.alias_cifrado),
        observaciones: await decryptField(env, registro.observaciones_cifradas),
      };
    } catch (e) {
      if (e instanceof CryptoConfigError) return Errors.internal(requestId);
      throw e;
    }
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'usuario', entidadId: email, estadoAnterior: null, estadoNuevo: 'datos_transferencia_revelados',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || `Registro de transferencia ${registro.id} revelado.`,
    });
    return ok({ action: 'revelar', ...plano }, requestId);
  }

  return Errors.validation('action inválida. Valores permitidos: editar, eliminar, revelar.', requestId);
}
