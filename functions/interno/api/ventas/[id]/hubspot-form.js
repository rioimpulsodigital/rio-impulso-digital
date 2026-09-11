// POST /interno/api/ventas/:id/hubspot-form — RIO-120 (11/09/2026,
// alcance simplificado por Brenda). El envío del formulario a HubSpot
// ahora lo hace el propio navegador (kit-venta-ficha-y-landing-page.html),
// DESPUÉS de que la venta ya quedó guardada en D1 — este endpoint solo
// recibe el resultado (pendiente/enviado/error nunca lo decide el
// servidor) para dejar un registro técnico mínimo y administrativo,
// visible en el Panel Administrativo (/interno/api/hubspot-sync).
//
// Lo llama el vendedor dueño de la venta (o administración) — nunca un
// tercero. Nunca bloquea ni revierte nada de la venta en D1, sin importar
// el resultado que reporte.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { registrarResultadoEnvioFormulario } from '../../../../_shared/hubspot.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) return Errors.methodNotAllowed(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  const esVendedor = roleIdentity.email === venta.vendedor_email;
  if (!esVendedor && !roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (!['enviado', 'error'].includes(body?.estado)) {
    return Errors.validation('estado inválido. Valores permitidos: enviado, error.', requestId);
  }
  // `resumen` es siempre texto corto y ya saneado del lado del navegador
  // (ej. "ok", "http_500") — nunca la respuesta cruda de HubSpot.
  const resumen = typeof body.resumen === 'string' ? body.resumen.slice(0, 200) : null;

  await registrarResultadoEnvioFormulario(env.DB, requestId, { ventaId: venta.id, estado: body.estado, resumen, actorEmail: roleIdentity.email });
  return ok({ action: 'hubspot-form' }, requestId);
}
