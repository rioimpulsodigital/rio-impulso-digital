// POST /interno/api/ventas/:id/componentes/:componenteId — RIO-113.
// Transiciones del componente: materiales-completos, iniciar-produccion,
// entregar, aprobar — según el body { action }.
//
// Quién puede: el ejecutivo dueño de la venta, o un supervisor/admin de su
// mercado (misma regla de propiedad que ya usa el detalle de la venta,
// RIO-112) — un asistente no puede todavía, no existe tabla de asignación
// de componentes (RIO-97 v2 lo documenta como "hoy sin nadie asignado").
// Decisión de alcance, no una restricción explícita del criterio de
// aceptación de la tarea: se documenta en el informe de cierre por si
// Brenda prefiere acotarlo más (ej. solo admin/supervisor) una vez que
// exista un rol de producción real.

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';
import {
  marcarMaterialesCompletos, iniciarProduccion, marcarEntregada, aprobarComponente, ProyectoError,
} from '../../../../../../_shared/proyectos.js';

const ACTIONS = {
  'materiales-completos': marcarMaterialesCompletos,
  'iniciar-produccion': iniciarProduccion,
  entregar: marcarEntregada,
  aprobar: aprobarComponente,
};

function errorStatusFor(code) {
  if (code === 'componente_no_encontrado' || code === 'pago_no_encontrado') return 404;
  return 409; // el recurso existe, pero su estado actual no permite esta transición.
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, ejecutivo_email, mercado FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    assertCanAccessOwner(roleIdentity, venta.ejecutivo_email, venta.mercado);
  } catch (e) {
    if (e instanceof AuthzError) return Errors.notFound(requestId); // mismo criterio que el detalle: no confirmar existencia ajena.
    throw e;
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  const handler = ACTIONS[body?.action];
  if (!handler) {
    return Errors.validation('action inválida. Valores permitidos: materiales-completos, iniciar-produccion, entregar, aprobar.', requestId);
  }

  try {
    const result = await handler(env.DB, requestId, { ventaId: venta.id, componenteId: params.componenteId, actorEmail: roleIdentity.email });
    return ok({ action: body.action, gate: result?.gate || null }, requestId);
  } catch (e) {
    if (e instanceof ProyectoError) {
      let details;
      try { details = JSON.parse(e.message); } catch (_) { details = undefined; }
      const status = errorStatusFor(e.code);
      const message = details ? 'No se puede realizar esta acción todavía — falta cumplir una condición.' : e.message;
      return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), message, requestId, details);
    }
    throw e;
  }
}
