// POST /interno/api/ventas/:id/componentes/:componenteId — RIO-113,
// permisos corregidos (Brenda, decisiones definitivas del 28/08/2026).
//
// Dos categorías de acción, con autorización distinta:
//   - REPORT_ACTIONS ('materiales-informados'): un dato reportado, nunca
//     avanza el estado oficial. Puede reportarlo el vendedor de ESTA
//     venta (vendedor_email === su email), o administración.
//   - Todo lo demás (materiales-completos, iniciar-produccion, entregar,
//     aprobar): transición OFICIAL — exclusiva de administración
//     (permissions.manageProduccionOficial), sin excepción para
//     supervisor ni para el vendedor dueño de la venta.
//
// En ambos casos, primero se exige poder VER la venta (misma regla de
// propiedad/mercado que el resto de /ventas/:id/*, assertCanAccessOwner)
// — quien no puede ni verla recibe 404; quien puede verla pero no tiene
// el permiso específico de la acción recibe 403.

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';
import {
  marcarMaterialesInformados, marcarMaterialesCompletos, iniciarProduccion, marcarEntregada, aprobarComponente, ProyectoError,
} from '../../../../../../_shared/proyectos.js';

const REPORT_ACTIONS = new Set(['materiales-informados']);

const ACTIONS = {
  'materiales-informados': marcarMaterialesInformados,
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

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    assertCanAccessOwner(roleIdentity, venta.vendedor_email, venta.mercado);
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
    return Errors.validation('action inválida. Valores permitidos: materiales-informados, materiales-completos, iniciar-produccion, entregar, aprobar.', requestId);
  }

  const esVendedor = roleIdentity.email === venta.vendedor_email;
  if (REPORT_ACTIONS.has(body.action)) {
    if (!esVendedor && !roleIdentity.permissions.manageProduccionOficial) {
      return Errors.forbidden(requestId); // un supervisor sin ser el vendedor no reporta materiales ajenos.
    }
  } else if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId); // transición oficial — exclusiva de administración, incluso para el vendedor dueño.
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
