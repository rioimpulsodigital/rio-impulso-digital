// GET /interno/api/ventas/:id/comisiones — RIO-114, visibilidad de
// supervisor consolidada en RIO-115 (31/08/2026, corrección sobre
// equipos). Lista las comisiones (comercial/supervisión/realización) de
// esta venta.
//
// Decisión CONFIRMADA por Brenda: esta información solo la ve
// administración en su totalidad, dentro de sus mercados autorizados. Un
// ejecutivo/asistente ve únicamente el cálculo completo de SU PROPIA
// comisión (beneficiario_email = su email). Un supervisor ve su propia
// comisión Y solo las comerciales de SU EQUIPO — nunca por mercado
// ("mercado no equivale a equipo"): dos supervisores del mismo mercado NO
// acceden automáticamente al equipo del otro. Sin acceso por supervisión
// a participaciones de realización/desarrollo/empresa de su equipo, ni a
// comprobantes bancarios ajenos (esas rutas ya están cerradas a
// administración vía manageProduccionOficial, sin excepción de
// supervisor).
//
// "Su equipo" se resuelve por `ventas.equipo_id` — la fotografía inmutable
// del equipo del vendedor al momento de la venta — contra
// `equipo_supervisores` VIGENTE para este supervisor. Una venta sin
// equipo_id (vendedor sin equipo asignado) nunca es visible por esta vía,
// solo por la rama de "propias" si el supervisor mismo generó una
// comisión sobre ella.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query } from '../../../../../_shared/db.js';
import { isMethodAllowed } from '../../../../../_shared/security.js';
import { costoDominioPendienteParaComision } from '../../../../../_shared/comisiones.js';

async function serialize(db, requestId, c) {
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
    motivoRetencionOReprogramacion: c.motivo_retencion_o_reprogramacion,
    // RIO-117 (corrección tras validación real, 01/09/2026): solo puede
    // ser true para una comisión asociada a una Landing Premium sin costo
    // de dominio confirmado todavía — nunca afecta Ficha ni Landing
    // genérica (ver costoDominioPendienteParaComision).
    costoDominioPendiente: await costoDominioPendienteParaComision(db, requestId, c),
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const ventaRows = await query(env.DB, requestId, 'SELECT id, vendedor_email, mercado, equipo_id FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  const esAdminDeSuMercado = roleIdentity.role === 'admin' && roleIdentity.allowedMarkets.includes(venta.mercado);
  if (esAdminDeSuMercado) {
    const comisiones = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE venta_id = ? ORDER BY tipo', [venta.id]);
    return ok({ comisiones: await Promise.all(comisiones.map((c) => serialize(env.DB, requestId, c))) }, requestId);
  }

  if (roleIdentity.role === 'supervisor' && venta.equipo_id) {
    const esSupervisorDelEquipo = await query(
      env.DB, requestId,
      `SELECT 1 FROM equipo_supervisores WHERE equipo_id = ? AND usuario_email = ?
       AND (valid_until IS NULL OR valid_until > datetime('now')) AND valid_from <= datetime('now')`,
      [venta.equipo_id, roleIdentity.email]
    );
    if (esSupervisorDelEquipo[0]) {
      // Su propia comisión (cualquier tipo) + la comercial de su equipo —
      // nunca realización/desarrollo/empresa ajenas.
      const comisiones = await query(
        env.DB, requestId,
        `SELECT * FROM comisiones WHERE venta_id = ? AND (tipo = 'comercial' OR beneficiario_email = ?) ORDER BY tipo`,
        [venta.id, roleIdentity.email]
      );
      if (comisiones.length === 0) return Errors.notFound(requestId);
      return ok({ comisiones: await Promise.all(comisiones.map((c) => serialize(env.DB, requestId, c))) }, requestId);
    }
  }

  // Ejecutivo/asistente (o supervisor de OTRO mercado): cada quien ve solo
  // SU PROPIA comisión sobre esta venta — nunca el detalle ajeno. Mismo
  // criterio que el resto de /ventas/:id/*: no confirmar existencia ajena
  // si no hay nada propio.
  const comisionesPropias = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE venta_id = ? AND beneficiario_email = ?', [venta.id, roleIdentity.email]);
  if (comisionesPropias.length === 0) return Errors.notFound(requestId);
  return ok({ comisiones: await Promise.all(comisionesPropias.map((c) => serialize(env.DB, requestId, c))) }, requestId);
}
