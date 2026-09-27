// POST/GET /interno/api/comisiones/conversiones/:conversionId/comprobante
// RIO-116, segundo bloque. El comprobante de CONVERSIÓN (evidencia real de
// la operación manual en Global66) es un documento distinto del de
// TRANSFERENCIA — nunca se tratan como el mismo archivo ni como sustitutos
// entre sí, aunque ambos puedan pertenecer a la misma liquidación.
//
// Permisos (Brenda, sección 2): administración tiene acceso completo
// (sube, consulta, descarga); la persona BENEFICIARIA de la comisión que
// originó esta conversión puede consultar y descargar, nunca subir; nadie
// más — "ser supervisor de la persona beneficiaria no concede acceso".

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../../_shared/security.js';
import { validarComprobante, guardarComprobante, obtenerComprobanteVigente, ArchivoError, ComprobanteError, MAX_COMPROBANTE_BYTES } from '../../../../../../_shared/comprobantes.js';

function serialize(c) {
  return {
    id: c.id,
    version: c.version,
    nombreOriginal: c.nombre_original,
    mimeType: c.mime_type,
    tamanoBytes: c.tamano_bytes,
    hashSha256: c.hash_sha256,
    subidoPor: c.subido_por,
    createdAt: c.created_at,
    rechazadoPor: c.rechazado_por || null,
    rechazadoEn: c.rechazado_en || null,
    motivoRechazo: c.motivo_rechazo || null,
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const rows = await query(
    env.DB, requestId,
    `SELECT conv.id, conv.comision_id, com.beneficiario_email
     FROM conversiones conv JOIN comisiones com ON com.id = conv.comision_id
     WHERE conv.id = ?`,
    [params.conversionId]
  );
  const conversion = rows[0];
  if (!conversion) return Errors.notFound(requestId);

  const esBeneficiario = roleIdentity.email === conversion.beneficiario_email;
  const esAdmin = !!roleIdentity.permissions.manageProduccionOficial;
  // Manipulación de ID: un id de conversión que no existe ya devolvió 404
  // arriba. Cualquier otra persona (incluida un supervisor de la persona
  // beneficiaria, u otro vendedor) recibe 403 — Brenda: "ser supervisor de
  // la persona beneficiaria no concede acceso al comprobante".
  if (!esBeneficiario && !esAdmin) return Errors.forbidden(requestId);

  if (request.method === 'GET') {
    const comprobante = await obtenerComprobanteVigente(env.DB, requestId, { tipo: 'conversion', referenciaId: conversion.id });
    return ok({ comprobante: comprobante ? serialize(comprobante) : null }, requestId);
  }

  // POST — subir, exclusivo de administración (nunca el beneficiario, ni
  // siquiera de su propia conversión: es un documento que administración
  // genera al operar en Global66, no algo que el vendedor aporta).
  if (!esAdmin) return Errors.forbidden(requestId);

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return Errors.validation('Content-Type debe ser multipart/form-data.', requestId);
  }
  const contentLength = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_COMPROBANTE_BYTES + 65536) {
    return Errors.validation(`El archivo supera el límite de ${MAX_COMPROBANTE_BYTES / (1024 * 1024)} MB.`, requestId);
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es un formulario válido.', requestId);
  }
  const archivo = form.get('archivo');

  let validado;
  try {
    validado = await validarComprobante(archivo);
  } catch (e) {
    if (e instanceof ArchivoError) return Errors.validation(e.message, requestId);
    throw e;
  }

  try {
    const { id, version } = await guardarComprobante(env.DB, env.COMPROBANTES, requestId, {
      tipo: 'conversion', referenciaId: conversion.id, ventaId: null, archivo: validado, subidoPor: roleIdentity.email,
    });
    return ok({ id, version }, requestId, 201);
  } catch (e) {
    if (e instanceof ComprobanteError) return Errors.internal(requestId);
    throw e;
  }
}
