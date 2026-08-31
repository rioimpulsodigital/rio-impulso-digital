// POST/GET /interno/api/comisiones/liquidaciones/:liquidacionId/comprobante-transferencia
// RIO-116, segundo bloque. El comprobante de TRANSFERENCIA acredita el
// pago final de la liquidación — documento distinto del de conversión,
// aunque ambos puedan pertenecer a la misma liquidación.
//
// Permisos (Brenda, sección 2): administración acceso completo; la
// persona BENEFICIARIA de la liquidación puede consultar y descargar,
// nunca subir; nadie más — "ser supervisor de la persona beneficiaria no
// concede acceso al comprobante".

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../../_shared/security.js';
import { validarComprobante, guardarComprobante, obtenerComprobanteVigente, ArchivoError, MAX_COMPROBANTE_BYTES } from '../../../../../../_shared/comprobantes.js';

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

  const rows = await query(env.DB, requestId, 'SELECT id, beneficiario_email FROM transferencias_comision WHERE id = ?', [params.liquidacionId]);
  const liquidacion = rows[0];
  if (!liquidacion) return Errors.notFound(requestId);

  const esBeneficiario = roleIdentity.email === liquidacion.beneficiario_email;
  const esAdmin = !!roleIdentity.permissions.manageProduccionOficial;
  if (!esBeneficiario && !esAdmin) return Errors.forbidden(requestId);

  if (request.method === 'GET') {
    const comprobante = await obtenerComprobanteVigente(env.DB, requestId, { tipo: 'transferencia', referenciaId: liquidacion.id });
    return ok({ comprobante: comprobante ? serialize(comprobante) : null }, requestId);
  }

  if (!esAdmin) return Errors.forbidden(requestId); // subir es exclusivo de administración.

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

  const { id, version } = await guardarComprobante(env.DB, env.COMPROBANTES, requestId, {
    tipo: 'transferencia', referenciaId: liquidacion.id, ventaId: null, archivo: validado, subidoPor: roleIdentity.email,
  });
  return ok({ id, version }, requestId, 201);
}
