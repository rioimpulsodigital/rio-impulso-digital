// GET /interno/api/ventas/:id/comisiones — RIO-114.
// Lista las comisiones (comercial/supervisión/producción) generadas para
// esta venta. Autorización más estricta que el resto de /ventas/:id/* —
// decisión CONFIRMADA por Brenda (28/08/2026, corrección de RIO-114), no
// una regla provisional: cada usuario ve el cálculo completo de sus
// propias comisiones (beneficiario_email = su email — esto cubre por igual
// al vendedor su comercial, al supervisor su supervisión, y al asistente
// su producción); el supervisor ve las ventas y operaciones de sus
// mercados (resto de /ventas/:id/*) pero NUNCA el importe/detalle de la
// comisión personal de otro usuario; el administrador consulta todas las
// comisiones dentro de sus mercados autorizados.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query } from '../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../_shared/security.js';

function serialize(c) {
  return {
    id: c.id,
    tipo: c.tipo,
    componenteId: c.componente_id,
    beneficiarioEmail: c.beneficiario_email,
    porcentaje: c.porcentaje_snapshot,
    base: c.base_snapshot,
    montoBase: c.monto_base,
    moneda: c.moneda,
    montoComision: c.monto_comision,
    estado: c.estado,
    fechaInicioPlazo: c.fecha_inicio_plazo,
    fechaCumplimientoPlazo: c.fecha_cumplimiento_plazo,
    fechaPagoTotalAcreditado: c.fecha_pago_total_acreditado,
    fechaHabilitacion: c.fecha_habilitacion,
    fechaProgramadaOriginal: c.fecha_programada_original,
    fechaProgramadaEfectiva: c.fecha_programada_efectiva,
    fechaPagoReal: c.fecha_pago_real,
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  const esAdminDeSuMercado = roleIdentity.role === 'admin' && roleIdentity.allowedMarkets.includes(venta.mercado);
  if (esAdminDeSuMercado) {
    const comisiones = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE venta_id = ? ORDER BY tipo', [venta.id]);
    return ok({ comisiones: comisiones.map(serialize) }, requestId);
  }

  // No admin: cada quien ve solo SU PROPIA comisión sobre esta venta (el
  // vendedor la suya comercial; un supervisor, la suya de supervisión, si
  // la tiene) — nunca el detalle ajeno. Mismo criterio que el resto de
  // /ventas/:id/*: no confirmar existencia ajena si no hay nada propio.
  const comisionesPropias = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE venta_id = ? AND beneficiario_email = ?', [venta.id, roleIdentity.email]);
  if (comisionesPropias.length === 0) return Errors.notFound(requestId);
  return ok({ comisiones: comisionesPropias.map(serialize) }, requestId);
}
