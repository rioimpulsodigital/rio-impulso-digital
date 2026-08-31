// GET /interno/api/ventas/:id/comisiones — RIO-114, visibilidad de
// supervisor corregida en RIO-115 (31/08/2026). Lista las comisiones
// (comercial/supervisión/producción/desarrollo) generadas para esta
// venta.
//
// Decisión CONFIRMADA por Brenda: esta información solo la ve
// administración en su totalidad; un ejecutivo/asistente ve únicamente el
// cálculo completo de SU PROPIA comisión (beneficiario_email = su email);
// un supervisor ve su propia comisión Y la de su equipo (antes se
// documentaba como "decisión abierta" en RIO-97 v2 sección 18 — ya no lo
// es). El administrador consulta todas las comisiones dentro de sus
// mercados autorizados.
//
// "Su equipo", hoy: no existe todavía una tabla de asignación de equipo
// independiente del mercado (RIO-97 v2 nunca la definió) — con un único
// supervisor por mercado, su mercado autorizado ES su equipo. Brenda ya
// avisó que esto cambia el día que haya más de un supervisor en el mismo
// mercado, cada uno con su propio equipo — ese día hace falta una tabla
// de equipo real; hoy sería prematuro inventarla sin uso.

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

  const esSupervisorDeSuMercado = roleIdentity.role === 'supervisor' && roleIdentity.allowedMarkets.includes(venta.mercado);
  if (esSupervisorDeSuMercado) {
    // Ve la suya y la de su equipo (hoy, su equipo = su mercado — ver nota
    // arriba). Nunca el detalle de un mercado que no supervisa.
    const comisiones = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE venta_id = ? ORDER BY tipo', [venta.id]);
    if (comisiones.length === 0) return Errors.notFound(requestId);
    return ok({ comisiones: comisiones.map(serialize) }, requestId);
  }

  // Ejecutivo/asistente (o supervisor de OTRO mercado): cada quien ve solo
  // SU PROPIA comisión sobre esta venta — nunca el detalle ajeno. Mismo
  // criterio que el resto de /ventas/:id/*: no confirmar existencia ajena
  // si no hay nada propio.
  const comisionesPropias = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE venta_id = ? AND beneficiario_email = ?', [venta.id, roleIdentity.email]);
  if (comisionesPropias.length === 0) return Errors.notFound(requestId);
  return ok({ comisiones: comisionesPropias.map(serialize) }, requestId);
}
