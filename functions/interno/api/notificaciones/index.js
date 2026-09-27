// GET /interno/api/notificaciones — RIO-116, segundo bloque. Lista las
// notificaciones internas para administración (pago informado, o nueva
// versión de un comprobante) — exclusivo de admin, nadie más tiene un rol
// destinatario todavía. `?pendientes=1` filtra a las no atendidas.

import { ok, Errors } from '../../../_shared/response.js';
import { isMethodAllowed } from '../../../_shared/security.js';
import { listarNotificaciones } from '../../../_shared/notificaciones.js';

function serialize(n) {
  return {
    id: n.id,
    tipo: n.tipo,
    ventaId: n.venta_id,
    pagoId: n.pago_id,
    mercado: n.mercado,
    clienteNegocio: n.cliente_negocio,
    vendedorEmail: n.vendedor_email,
    rutaPortal: n.ruta_portal,
    leidaEn: n.leida_en,
    leidaPor: n.leida_por,
    atendidaEn: n.atendida_en,
    atendidaPor: n.atendida_por,
    createdAt: n.created_at,
  };
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }

  const url = new URL(request.url);
  const soloPendientes = url.searchParams.get('pendientes') === '1';
  const rows = await listarNotificaciones(env.DB, requestId, { soloPendientes });
  return ok({ notificaciones: rows.map(serialize) }, requestId);
}
