// POST /interno/api/ventas/:id/pagos/:pagoId — RIO-113.
// action: 'informar' (ejecutivo dueño de la venta, o supervisor/admin de su
// mercado) o 'acreditar' (SOLO admin — verificar acreditación bancaria es
// una acción exclusiva de admin, RIO-97 v2 sección 5).
//
// "Informado ≠ acreditado" (RIO-97): son dos pasos separados, con su
// propio responsable — nunca se puede acreditar sin haber informado antes.

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';
import { informarPago, acreditarPago, ProyectoError } from '../../../../../../_shared/proyectos.js';

function errorStatusFor(code) {
  if (code === 'pago_no_encontrado') return 404;
  return 409;
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
    if (e instanceof AuthzError) return Errors.notFound(requestId);
    throw e;
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action === 'acreditar') {
    if (!roleIdentity.permissions.verifyPayments) {
      return Errors.forbidden(requestId); // solo admin puede verificar acreditación bancaria.
    }
    if (!Number.isInteger(body.montoAcreditado) || body.montoAcreditado <= 0) {
      return Errors.validation('montoAcreditado inválido.', requestId);
    }
    try {
      const result = await acreditarPago(env.DB, requestId, {
        ventaId: venta.id, pagoId: params.pagoId, montoAcreditado: body.montoAcreditado, nota: body.nota, actorEmail: roleIdentity.email,
      });
      return ok({ action: 'acreditar', gate: result.gate }, requestId);
    } catch (e) {
      if (e instanceof ProyectoError) {
        const status = errorStatusFor(e.code);
        return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
      }
      throw e;
    }
  }

  if (body?.action === 'informar') {
    if (!Number.isInteger(body.montoInformado) || body.montoInformado <= 0) {
      return Errors.validation('montoInformado inválido.', requestId);
    }
    try {
      await informarPago(env.DB, requestId, {
        ventaId: venta.id, pagoId: params.pagoId, montoInformado: body.montoInformado, comprobanteNota: body.comprobanteNota, actorEmail: roleIdentity.email,
      });
      return ok({ action: 'informar' }, requestId);
    } catch (e) {
      if (e instanceof ProyectoError) {
        const status = errorStatusFor(e.code);
        return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
      }
      throw e;
    }
  }

  return Errors.validation('action inválida. Valores permitidos: informar, acreditar.', requestId);
}
