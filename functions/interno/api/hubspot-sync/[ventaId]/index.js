// POST /interno/api/hubspot-sync/:ventaId — RIO-120 (11/09/2026).
// Exclusivo de administración: 'reintentar' (dispara sincronizarVentaConHubSpot
// de nuevo — nunca crea un segundo negocio, busca por rio_venta_id antes de
// crear) o 'descartar' (con motivo obligatorio, nunca borra la fila).
//
// Las 2 filas legacy de Forms API (1/09 y 3/09, marcadas como spam por
// HubSpot) NUNCA se reenvían desde acá — sincronizarVentaConHubSpot ya las
// excluye estructuralmente (canal 'forms_api_legacy'), así que ni
// reintentar ni descartar las toca; quedan visibles solo para auditoría.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { sincronizarVentaConHubSpot, descartarSincronizacion, obtenerEstadoSincronizacion } from '../../../../_shared/hubspot.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  const ventaRows = await query(env.DB, requestId, 'SELECT id FROM ventas WHERE id = ?', [params.ventaId]);
  if (!ventaRows[0]) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const existente = await obtenerEstadoSincronizacion(env.DB, requestId, params.ventaId);
  if (existente?.canal === 'forms_api_legacy') {
    return Errors.conflict('SINCRONIZACION_LEGACY', 'Este registro corresponde al envío temporal de Forms API (marcado como spam por HubSpot) — no se reintenta ni se descarta desde acá, solo queda visible para auditoría.', requestId);
  }

  if (body?.action === 'reintentar') {
    const resultado = await sincronizarVentaConHubSpot(env.DB, requestId, env, { ventaId: params.ventaId, actorEmail: roleIdentity.email });
    return ok({ action: 'reintentar', estado: resultado.estado, resumen: resultado.resumen }, requestId);
  }

  if (body?.action === 'descartar') {
    if (typeof body.motivo !== 'string' || !body.motivo.trim()) {
      return Errors.validation('Descartar una sincronización requiere un motivo.', requestId);
    }
    const id = await descartarSincronizacion(env.DB, requestId, { ventaId: params.ventaId, motivo: body.motivo.trim(), actorEmail: roleIdentity.email });
    if (!id) return Errors.notFound(requestId);
    return ok({ action: 'descartar' }, requestId);
  }

  return Errors.validation('action inválida. Valores permitidos: reintentar, descartar.', requestId);
}
