// GET /interno/api/ventas/:id/historial — RIO-113.
// Línea de tiempo completa (append-only) de una venta: cambios de estado
// de proyecto/componentes/pagos, con responsable, fecha, motivo, próxima
// acción y su responsable. Misma autorización por propiedad/mercado que el
// resto de /ventas/:id/* — cancelaciones y disputas no eliminan nada de
// este historial, solo agregan más eventos.

import { ok, Errors } from '../../../../_shared/response.js';
import { query } from '../../../../_shared/db.js';
import { assertCanViewVentaDetalle, AuthzError } from '../../../../_shared/authz.js';
import { isMethodAllowed } from '../../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado, equipo_id FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    // RIO-118 (corrección — equipos, 01/09/2026): mismo criterio de
    // ventas/[id].js — el historial expone motivos y notas internas, no
    // solo un mercado, así que un supervisor necesita además pertenecer
    // al equipo de esta venta.
    await assertCanViewVentaDetalle(env.DB, requestId, roleIdentity, venta);
  } catch (e) {
    if (e instanceof AuthzError) return Errors.notFound(requestId);
    throw e;
  }

  const eventos = await query(
    env.DB, requestId,
    'SELECT * FROM eventos_historial WHERE venta_id = ? ORDER BY created_at ASC',
    [venta.id]
  );

  return ok(
    {
      eventos: eventos.map((e) => ({
        id: e.id,
        entidad: e.entidad,
        entidadId: e.entidad_id,
        estadoAnterior: e.estado_anterior,
        estadoNuevo: e.estado_nuevo,
        usuarioEmail: e.usuario_email,
        motivoNota: e.motivo_nota,
        proximaAccion: e.proxima_accion,
        responsableProximaAccion: e.responsable_proxima_accion,
        createdAt: e.created_at,
      })),
    },
    requestId
  );
}
