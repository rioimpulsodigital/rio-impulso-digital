// GET /interno/api/comisiones/propias — RIO-122 (22/09/2026, cumplimiento
// funcional: visibilidad de comisiones propias).
//
// Regla aprobada (RIO-114/115/121: "cada persona ve sus propias comisiones",
// auditada como "Beneficiario propio"): toda persona que es beneficiaria
// legítima de una comisión puede consultarla, AUNQUE no sea el
// `vendedor_email` de la venta (realización/practicante, participante de un
// proyecto personalizado, supervisor de otro equipo, etc.) — sin adquirir
// por eso ningún acceso a la venta ni a información económica o personal
// ajena.
//
// Hasta acá "Mis comisiones" solo recorría las ventas donde el usuario es
// vendedor (GET /ventas → GET /ventas/:id/comisiones): un beneficiario que
// no vendió esa venta recibe 404 de GET /ventas y nunca conocía su
// `ventaId`, así que su comisión no aparecía en ninguna pantalla.
//
// Seguridad:
// - El beneficiario sale EXCLUSIVAMENTE de la identidad autenticada
//   (`roleIdentity.email`, resuelta server-side por Access + D1). La ruta no
//   lee ningún parámetro de la solicitud — ni query string ni body — así que
//   nada del navegador puede cambiar de quién son las comisiones devueltas.
// - Es una vista distinta y más acotada que GET /ventas/:id/comisiones: NO
//   devuelve nombre del cliente ni del negocio, precio de la venta, pagos ni
//   acreditaciones del cliente (ni las fechas que las revelan:
//   fechaInicioPlazo / fechaPagoTotalAcreditado), materiales, costos (ni el
//   aviso de costo de dominio), la distribución económica, el % de empresa,
//   comisiones de terceros ni el detalle de la venta. Solo lo mínimo para
//   identificar la comisión: código de venta, producto y mercado.
// - Las comisiones de una versión de distribución ya 'reemplazada'
//   (proyecto personalizado corregido) quedan inertes para siempre y no se
//   listan — mismo criterio que saldoDisponibleComision().

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { isMethodAllowed } from '../../../_shared/security.js';
import { calcularFechaPrevistaComision } from '../../../_shared/comisiones.js';

async function serializePropia(db, requestId, c) {
  return {
    id: c.id,
    tipo: c.tipo,
    rolRealizacion: c.rol_realizacion || null,
    // Se conserva para que el panel filtre "las mías" con el mismo criterio
    // que ya usa; siempre es el propio usuario autenticado.
    beneficiarioEmail: c.beneficiario_email,
    codigoVenta: c.codigo_venta,
    producto: c.producto,
    mercado: c.mercado,
    porcentaje: c.porcentaje_snapshot,
    base: c.base_snapshot,
    montoBase: c.monto_base,
    moneda: c.moneda,
    montoComision: c.monto_comision,
    estado: c.estado,
    fechaHabilitacion: c.fecha_habilitacion,
    fechaProgramadaOriginal: c.fecha_programada_original,
    fechaProgramadaEfectiva: c.fecha_programada_efectiva,
    fechaPagoReal: c.fecha_pago_real,
    fechaPrevistaPago: await calcularFechaPrevistaComision(db, requestId, c.id),
    motivoRetencionOReprogramacion: c.motivo_retencion_o_reprogramacion,
  };
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const filas = await query(
    env.DB, requestId,
    `SELECT c.*, v.codigo_venta, v.producto, v.mercado
       FROM comisiones c
       JOIN ventas v ON v.id = c.venta_id
       LEFT JOIN venta_distribuciones vd ON vd.id = c.distribucion_id
      WHERE c.beneficiario_email = ?
        AND (c.distribucion_id IS NULL OR vd.estado = 'confirmada')
      ORDER BY c.created_at DESC`,
    [roleIdentity.email]
  );

  return ok({ comisiones: await Promise.all(filas.map((c) => serializePropia(env.DB, requestId, c))) }, requestId);
}
