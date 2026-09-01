// POST /interno/api/ventas/:id/pagos/:pagoId — RIO-113, permisos
// corregidos (Brenda, decisiones definitivas del 28/08/2026).
// action: 'informar' (el vendedor de ESTA venta, o administración — un
// supervisor que no vendió esta venta no puede informar pagos ajenos,
// aunque sea de su mismo mercado) o 'acreditar' (SOLO admin — verificar
// acreditación bancaria es una acción exclusiva de admin, RIO-97 v2
// sección 5).
//
// "Informado ≠ acreditado" (RIO-97): son dos pasos separados, con su
// propio responsable — nunca se puede acreditar sin haber informado antes.

import { ok, Errors } from '../../../../../../_shared/response.js';
import { query } from '../../../../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../../_shared/security.js';
import { informarPago, acreditarPago, rechazarPago, ProyectoError } from '../../../../../../_shared/proyectos.js';
import { crearNotificacionSiCorresponde } from '../../../../../../_shared/notificaciones.js';
import { rechazarComprobante, ComprobanteError } from '../../../../../../_shared/comprobantes.js';

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

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    assertCanAccessOwner(roleIdentity, venta.vendedor_email, venta.mercado);
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
    const esVendedor = roleIdentity.email === venta.vendedor_email;
    if (!esVendedor && !roleIdentity.permissions.manageProduccionOficial) {
      return Errors.forbidden(requestId); // un supervisor sin ser el vendedor no informa pagos ajenos.
    }
    if (!Number.isInteger(body.montoInformado) || body.montoInformado <= 0) {
      return Errors.validation('montoInformado inválido.', requestId);
    }
    try {
      const { pagoInformadoId } = await informarPago(env.DB, requestId, {
        ventaId: venta.id, pagoId: params.pagoId, montoInformado: body.montoInformado, comprobanteNota: body.comprobanteNota, actorEmail: roleIdentity.email,
      });
      // RIO-116 segundo bloque: notificar a administración — nunca
      // bloquea "informar" si la notificación falla (consecuencia
      // informativa, no un requisito del informe en sí).
      try {
        const clienteRows = await query(env.DB, requestId, 'SELECT c.negocio FROM ventas v JOIN clientes c ON c.id = v.cliente_id WHERE v.id = ?', [venta.id]);
        await crearNotificacionSiCorresponde(env.DB, requestId, {
          tipo: 'pago_informado',
          claveIdempotencia: `pago_informado:${pagoInformadoId}`,
          ventaId: venta.id, pagoId: params.pagoId, mercado: venta.mercado,
          clienteNegocio: clienteRows[0]?.negocio || null, vendedorEmail: venta.vendedor_email,
          rutaPortal: `/interno/index.html?venta=${venta.id}&pago=${params.pagoId}`,
        });
      } catch (e) {
        console.error(JSON.stringify({ requestId, scope: 'notificaciones', reason: 'creacion_fallida' }));
      }
      return ok({ action: 'informar' }, requestId);
    } catch (e) {
      if (e instanceof ProyectoError) {
        const status = errorStatusFor(e.code);
        return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
      }
      throw e;
    }
  }

  if (body?.action === 'rechazar') {
    // RIO-116: rechazar un comprobante/pago informado — solo admin, mismo
    // permiso que acreditar (verifyPayments), nunca el vendedor.
    if (!roleIdentity.permissions.verifyPayments) {
      return Errors.forbidden(requestId);
    }
    if (typeof body.motivo !== 'string' || !body.motivo.trim()) {
      return Errors.validation('Falta motivo.', requestId);
    }
    try {
      const { pagoInformadoId } = await rechazarPago(env.DB, requestId, { ventaId: venta.id, pagoId: params.pagoId, motivo: body.motivo.trim(), actorEmail: roleIdentity.email });
      // RIO-116 (verificación final): además de revertir el pago a
      // 'pendiente', marcar el comprobante de PAGO vigente (si había uno
      // subido) como rechazado — así el vendedor lo ve reflejado al
      // consultar GET .../comprobante, con el mismo motivo, sin tener que
      // ir a buscarlo al historial. Puede no haber ningún comprobante
      // todavía (el admin puede rechazar solo por el monto informado, sin
      // archivo) — eso es válido, no es un error.
      if (pagoInformadoId) {
        try {
          await rechazarComprobante(env.DB, requestId, { tipo: 'pago', referenciaId: pagoInformadoId, motivo: body.motivo.trim(), actorEmail: roleIdentity.email });
        } catch (e) {
          if (!(e instanceof ComprobanteError)) throw e;
          // 'comprobante_no_encontrado' es esperable (rechazo sin archivo
          // subido todavía) — no es un error a propagar.
        }
      }
      return ok({ action: 'rechazar' }, requestId);
    } catch (e) {
      if (e instanceof ProyectoError) {
        const status = errorStatusFor(e.code);
        return status === 404 ? Errors.notFound(requestId) : Errors.conflict(e.code.toUpperCase(), e.message, requestId);
      }
      throw e;
    }
  }

  return Errors.validation('action inválida. Valores permitidos: informar, acreditar, rechazar.', requestId);
}
