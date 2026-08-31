// POST/GET /interno/api/ventas/:id/pagos/:pagoId/comprobante — RIO-116.
//
// Acceso deliberadamente MÁS estricto que el resto de las rutas de venta:
// solo el vendedor de ESTA venta o administración — nunca un supervisor,
// aunque comparta mercado o equipo con el vendedor (Brenda: "el supervisor
// puede ver el estado del pago, pero no comprobantes bancarios ajenos").
// Por eso esta ruta NO usa `assertCanAccessOwner` (que sí deja pasar a un
// supervisor de mercado) — implementa su propio chequeo, más angosto.
//
// POST: sube un comprobante nuevo (multipart/form-data, campo `archivo`).
// Requiere que el pago ya esté informado — el comprobante se adjunta al
// pago informado más reciente, no a un pago todavía pendiente. Una
// re-subida crea una versión nueva (comprobantes.js) — nunca sobrescribe.
//
// GET: metadatos del comprobante vigente (nunca el archivo — para eso ver
// [comprobanteId]/archivo.js). Nunca expone el archivo directamente acá.

import { ok, Errors } from '../../../../../../../_shared/response.js';
import { query } from '../../../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../../../_shared/security.js';
import { validarComprobante, guardarComprobante, obtenerComprobanteVigente, ArchivoError, MAX_COMPROBANTE_BYTES } from '../../../../../../../_shared/comprobantes.js';

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
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  // Dos niveles, mismo criterio que el resto del sistema desde RIO-112:
  // (1) quien ni siquiera puede VER que esta venta existe (ejecutivo ajeno,
  // o supervisor/admin de otro mercado) recibe 404 — nunca confirmar
  // existencia. (2) quien SÍ puede ver la venta pero no tiene derecho al
  // comprobante específico (un supervisor de su propio mercado, que en
  // cualquier otra ruta la vería normalmente) recibe 403 — Brenda: "el
  // supervisor puede ver el estado del pago, pero no comprobantes
  // bancarios ajenos". Por eso esta ruta NO reutiliza `assertCanAccessOwner`
  // (que sí le daría acceso pleno a un supervisor de mercado) para la
  // decisión final, solo para saber si la venta es visible.
  const esVendedor = roleIdentity.email === venta.vendedor_email;
  const esAdmin = !!roleIdentity.permissions.manageProduccionOficial;
  const puedeVerVenta = esVendedor || esAdmin
    || (roleIdentity.permissions.viewOthersData && roleIdentity.allowedMarkets.includes(venta.mercado));
  if (!puedeVerVenta) return Errors.notFound(requestId);
  if (!esVendedor && !esAdmin) return Errors.forbidden(requestId);

  const pagoRows = await query(env.DB, requestId, 'SELECT id, estado FROM pagos_esperados WHERE id = ? AND venta_id = ?', [params.pagoId, venta.id]);
  const pago = pagoRows[0];
  if (!pago) return Errors.notFound(requestId);

  if (request.method === 'GET') {
    const informados = await query(env.DB, requestId, 'SELECT id FROM pagos_informados WHERE pago_esperado_id = ? ORDER BY created_at DESC LIMIT 1', [pago.id]);
    const pagoInformado = informados[0];
    if (!pagoInformado) return ok({ comprobante: null }, requestId);
    const comprobante = await obtenerComprobanteVigente(env.DB, requestId, { tipo: 'pago', referenciaId: pagoInformado.id });
    return ok({ comprobante: comprobante ? serialize(comprobante) : null }, requestId);
  }

  // POST — subir un comprobante nuevo. Exclusivo del vendedor propio o
  // admin (mismo chequeo de arriba); un supervisor nunca llega hasta acá.
  const informados = await query(env.DB, requestId, 'SELECT id FROM pagos_informados WHERE pago_esperado_id = ? ORDER BY created_at DESC LIMIT 1', [pago.id]);
  const pagoInformado = informados[0];
  if (!pagoInformado) {
    return Errors.validation('Este pago todavía no fue informado — informalo antes de adjuntar el comprobante.', requestId);
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return Errors.validation('Content-Type debe ser multipart/form-data.', requestId);
  }
  const contentLength = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_COMPROBANTE_BYTES + 65536) {
    // Margen generoso por el overhead del multipart — el límite real y
    // estricto se aplica después contra el tamaño real decodificado.
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
    if (e instanceof ArchivoError) {
      return Errors.validation(e.message, requestId);
    }
    throw e;
  }

  const { id, version } = await guardarComprobante(env.DB, env.COMPROBANTES, requestId, {
    tipo: 'pago', referenciaId: pagoInformado.id, ventaId: venta.id, archivo: validado, subidoPor: roleIdentity.email,
  });

  return ok({ id, version }, requestId, 201);
}
