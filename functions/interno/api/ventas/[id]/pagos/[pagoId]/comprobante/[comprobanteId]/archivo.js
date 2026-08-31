// GET /interno/api/ventas/:id/pagos/:pagoId/comprobante/:comprobanteId/archivo
// RIO-116 — la ÚNICA ruta que entrega los bytes reales del comprobante.
// Nunca un link directo a R2 (el bucket es privado, sin dominio público) —
// esta función lee el objeto por el binding del Worker y lo transmite,
// después de repetir el mismo control de acceso estricto que el resto de
// esta carpeta: vendedor propio de la venta, o administración. Un
// supervisor nunca llega hasta acá, aunque conozca el id del comprobante.

import { Errors } from '../../../../../../../../_shared/response.js';
import { query } from '../../../../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  // Mismo criterio de dos niveles que comprobante/index.js: 404 para quien
  // ni ve que la venta existe, 403 para un supervisor que sí la ve pero no
  // tiene derecho al archivo bancario ajeno.
  const esVendedor = roleIdentity.email === venta.vendedor_email;
  const esAdmin = !!roleIdentity.permissions.manageProduccionOficial;
  const puedeVerVenta = esVendedor || esAdmin
    || (roleIdentity.permissions.viewOthersData && roleIdentity.allowedMarkets.includes(venta.mercado));
  if (!puedeVerVenta) return Errors.notFound(requestId);
  if (!esVendedor && !esAdmin) return Errors.forbidden(requestId);

  const rows = await query(
    env.DB, requestId,
    `SELECT c.* FROM comprobantes c
     JOIN pagos_informados pi ON pi.id = c.referencia_id
     WHERE c.id = ? AND c.tipo = 'pago' AND pi.pago_esperado_id = ? AND c.venta_id = ?`,
    [params.comprobanteId, params.pagoId, venta.id]
  );
  const comprobante = rows[0];
  if (!comprobante) return Errors.notFound(requestId);

  const object = await env.COMPROBANTES.get(comprobante.r2_key);
  if (!object) {
    // El registro en D1 existe pero el objeto no está en R2 — inconsistencia
    // real, nunca se debe fingir éxito ni exponer el detalle interno al cliente.
    console.error(JSON.stringify({ requestId, scope: 'comprobantes', reason: 'objeto_r2_faltante', comprobanteId: comprobante.id }));
    return Errors.internal(requestId);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': comprobante.mime_type,
      'Content-Disposition': `inline; filename="${comprobante.nombre_original.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
