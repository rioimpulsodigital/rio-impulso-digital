// POST /interno/api/ventas/:id/hubspot-form — RIO-120 (11/09/2026,
// corrección de confiabilidad, 11/09/2026 más tarde). El envío del
// formulario a HubSpot lo sigue haciendo el propio navegador
// (kit-venta-ficha-y-landing-page.html), siempre DESPUÉS de que la venta
// ya quedó guardada en D1 — este endpoint resuelve DOS cosas, ambas en el
// backend, nunca solo con una variable del navegador:
//
// action: 'reclamar-intento' — "¿puedo intentar enviar ahora?" El
//   navegador lo llama SIEMPRE que confirma una venta (creación nueva o
//   replay de idempotencia) — así un intento que falló en una
//   confirmación anterior se reintenta solo. Nunca autoriza dos intentos
//   a la vez (dos pestañas) ni reenvía algo ya confirmado 'enviado'. Un
//   intento abandonado (pestaña cerrada a mitad de camino) vence solo y
//   vuelve a quedar disponible.
// action: 'reportar-resultado' — el navegador reporta qué pasó después
//   de intentar (o de saltar el envío real en Preview).
//
// Lo llama el vendedor dueño de la venta (o administración) — nunca un
// tercero. Nunca bloquea ni revierte nada de la venta en D1, sin importar
// el resultado.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { reclamarIntentoEnvio, registrarResultadoEnvioFormulario } from '../../../../_shared/hubspot.js';

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

  if (body?.action === 'reclamar-intento') {
    const resultado = await reclamarIntentoEnvio(env.DB, requestId, { ventaId: venta.id, actorEmail: roleIdentity.email });
    return ok(resultado, requestId);
  }

  // Comportamiento por defecto (sin action, o action: 'reportar-resultado')
  // — compatibilidad con lo ya wireado en el Kit.
  if (!['enviado', 'error'].includes(body?.estado)) {
    return Errors.validation('estado inválido. Valores permitidos: enviado, error.', requestId);
  }
  // `resumen` es siempre texto corto y ya saneado del lado del navegador
  // (ej. "ok", "http_500") — nunca la respuesta cruda de HubSpot.
  const resumen = typeof body.resumen === 'string' ? body.resumen.slice(0, 200) : null;
  await registrarResultadoEnvioFormulario(env.DB, requestId, { ventaId: venta.id, estado: body.estado, resumen, actorEmail: roleIdentity.email });
  return ok({ action: 'hubspot-form' }, requestId);
}
