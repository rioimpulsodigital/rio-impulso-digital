// POST /interno/api/hubspot-sync/:ventaId — RIO-120 (corrección de
// confiabilidad, 11/09/2026). Fallback EXCLUSIVO de administración para
// cuando el navegador del vendedor nunca llegó a completar el envío
// (pestaña cerrada, red caída) y nadie puede reabrir esa sesión real —
// "Administración debe poder reintentarlo posteriormente sin volver a
// crear la venta" (Brenda). Única acción: 'reintentar'. Nunca crea un
// negocio, nunca usa Objects API ni token privado — sigue siendo la misma
// Forms API pública que usa el Kit, con los mismos campos aprobados,
// reconstruidos desde D1 (ver enviarFormularioServerSide).
//
// Usa el mismo mecanismo de reclamo/lease que el navegador — si el
// vendedor está intentando en simultáneo, esta acción respeta esa carrera
// igual que cualquier otro intento (nunca fuerza un envío duplicado).

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { reclamarIntentoEnvio, registrarResultadoEnvioFormulario, enviarFormularioServerSide } from '../../../../_shared/hubspot.js';

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
  if (body?.action !== 'reintentar') {
    return Errors.validation('action inválida. Valores permitidos: reintentar.', requestId);
  }

  const reclamo = await reclamarIntentoEnvio(env.DB, requestId, { ventaId: params.ventaId, actorEmail: roleIdentity.email });
  if (!reclamo.autorizado) {
    return Errors.conflict('SINCRONIZACION_NO_DISPONIBLE', reclamo.motivo === 'ya_enviado' ? 'Esta venta ya fue enviada a HubSpot.' : 'Ya hay un intento en curso para esta venta.', requestId);
  }

  const resultado = await enviarFormularioServerSide(env.DB, requestId, params.ventaId);
  await registrarResultadoEnvioFormulario(env.DB, requestId, {
    ventaId: params.ventaId, estado: resultado.ok ? 'enviado' : 'error', resumen: resultado.resumen, actorEmail: roleIdentity.email,
  });
  return ok({ action: 'reintentar', estado: resultado.ok ? 'enviado' : 'error' }, requestId);
}
