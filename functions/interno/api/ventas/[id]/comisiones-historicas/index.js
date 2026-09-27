// GET/POST /interno/api/ventas/:id/comisiones-historicas — RIO-119 (cuarto
// bloque, 03/09/2026; ampliado a 3 tipos de registro en el sexto bloque,
// 04/09/2026). Exclusivo de administración, solo aplica a ventas marcadas
// como importación histórica (modo_historico no nulo).
//
// TABLA SEPARADA de `comisiones` (ver migración 0029 para la auditoría
// completa de alternativas) — estructuralmente invisible para toda la
// máquina de estados de comisiones: nunca entra al calendario 10/25,
// nunca dispara notificaciones, nunca se recalcula con planes vigentes,
// nunca genera deuda actual ni altera liquidaciones vigentes.
//
// cliente/proyecto/producto/mercado/moneda/precio ya están disponibles en
// la venta vinculada (ventas.cliente_id/producto/mercado/moneda/
// precio_pactado) — esta tabla nunca los duplica.
//
// tipoRegistro (Brenda, 04/09/2026):
//   'solo_referencia'      — no hay reconstrucción económica completa.
//   'reconstruido'         — se cargaron importes que YA ocurrieron
//                            (comisiones ya pagadas antes de incorporarse).
//   'obligacion_pendiente' — EXCEPCIONAL: una deuda real confirmada,
//                            todavía sin pagar. Nunca se infiere — exige
//                            confirmación administrativa explícita
//                            (confirmarObligacion=true), beneficiario,
//                            monto, moneda y evidencia.
//
// "Nunca conviertas automáticamente un proyecto histórico en una comisión
// viva por inferencia": ningún código de generación de comisiones
// (generarComisionesDesdeDistribucion, evaluateComisionGate, etc.) lee
// jamás esta tabla — es estructuralmente imposible que una fila de acá se
// vuelva una comisión real.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query, execute } from '../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../_shared/security.js';
import { logEvento } from '../../../../../_shared/historial.js';

const VALID_TIPOS_REGISTRO = ['solo_referencia', 'reconstruido', 'obligacion_pendiente'];
const VALID_CONCEPTOS = ['comercial', 'supervision', 'desarrollo', 'realizacion', 'produccion'];
const VALID_MONEDAS = ['CLP', 'ARS'];
const VALID_NIVELES_CERTEZA = ['alta', 'media', 'baja'];

function serialize(row) {
  return {
    id: row.id,
    tipoRegistro: row.tipo_registro,
    beneficiarioEmail: row.beneficiario_email || null,
    concepto: row.concepto || null,
    distribucionConocida: row.distribucion_conocida || null,
    pagosRecibidos: row.pagos_recibidos ?? null,
    importePagado: row.importe_pagado ?? null,
    montoEmpresa: row.monto_empresa ?? null,
    moneda: row.moneda || null,
    estadoFinal: row.estado_final || null,
    observaciones: row.observaciones || null,
    nivelCerteza: row.nivel_certeza || null,
    fechaExacta: row.fecha_exacta || null,
    fechaAproximada: row.fecha_aproximada || null,
    evidencia: row.evidencia || null,
    fuente: row.fuente,
    declaradoPor: row.declarado_por,
    confirmadoPorAdmin: !!row.confirmado_por_admin,
    createdAt: row.created_at,
  };
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const ventaRows = await query(env.DB, requestId, 'SELECT id, modo_historico FROM ventas WHERE id = ?', [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);
  if (!venta.modo_historico) {
    return Errors.validation('Las comisiones históricas solo aplican a ventas marcadas como importación histórica.', requestId);
  }

  if (request.method === 'GET') {
    const rows = await query(env.DB, requestId, 'SELECT * FROM comisiones_historicas WHERE venta_id = ? ORDER BY created_at ASC', [venta.id]);
    return ok({ comisionesHistoricas: rows.map(serialize) }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const {
    tipoRegistro, beneficiarioEmail, concepto, distribucionConocida, pagosRecibidos, importePagado, montoEmpresa,
    moneda, estadoFinal, observaciones, nivelCerteza, fechaExacta, fechaAproximada, evidencia, fuente, confirmarObligacion,
  } = body || {};

  if (!VALID_TIPOS_REGISTRO.includes(tipoRegistro)) {
    return Errors.validation(`tipoRegistro inválido. Valores permitidos: ${VALID_TIPOS_REGISTRO.join(', ')}.`, requestId);
  }
  if (concepto !== undefined && concepto !== null && !VALID_CONCEPTOS.includes(concepto)) {
    return Errors.validation(`concepto inválido. Valores permitidos: ${VALID_CONCEPTOS.join(', ')}.`, requestId);
  }
  if (moneda !== undefined && moneda !== null && !VALID_MONEDAS.includes(moneda)) {
    return Errors.validation(`moneda inválida. Valores permitidos: ${VALID_MONEDAS.join(', ')}.`, requestId);
  }
  if (nivelCerteza !== undefined && nivelCerteza !== null && !VALID_NIVELES_CERTEZA.includes(nivelCerteza)) {
    return Errors.validation(`nivelCerteza inválido. Valores permitidos: ${VALID_NIVELES_CERTEZA.join(', ')}.`, requestId);
  }
  if (!fechaExacta && !fechaAproximada) return Errors.validation('Se requiere fechaExacta o fechaAproximada (al menos una).', requestId);
  if (typeof fuente !== 'string' || !fuente.trim()) return Errors.validation('Falta fuente (de dónde se obtuvo este dato).', requestId);

  // "Obligación histórica pendiente" es EXCEPCIONAL — exige todo lo que
  // pide Brenda explícitamente: confirmación explícita, beneficiario,
  // monto y moneda, motivo (ya cubierto por fuente/observaciones),
  // evidencia disponible.
  let confirmadoPorAdmin = 0;
  if (tipoRegistro === 'obligacion_pendiente') {
    if (confirmarObligacion !== true) {
      return Errors.validation('Registrar una obligación histórica pendiente requiere confirmación administrativa explícita (confirmarObligacion=true).', requestId);
    }
    if (typeof beneficiarioEmail !== 'string' || !beneficiarioEmail.trim()) return Errors.validation('Una obligación pendiente requiere beneficiarioEmail.', requestId);
    if (!Number.isInteger(importePagado) || importePagado <= 0) return Errors.validation('Una obligación pendiente requiere un monto (importePagado) entero positivo.', requestId);
    if (!moneda) return Errors.validation('Una obligación pendiente requiere moneda.', requestId);
    if (typeof evidencia !== 'string' || !evidencia.trim()) return Errors.validation('Una obligación pendiente requiere evidencia disponible.', requestId);
    confirmadoPorAdmin = 1;
  }
  if (beneficiarioEmail !== undefined && beneficiarioEmail !== null && typeof beneficiarioEmail !== 'string') {
    return Errors.validation('beneficiarioEmail debe ser texto.', requestId);
  }
  if (importePagado !== undefined && importePagado !== null && (!Number.isInteger(importePagado) || importePagado < 0)) {
    return Errors.validation('importePagado debe ser un entero mayor o igual a 0.', requestId);
  }
  if (pagosRecibidos !== undefined && pagosRecibidos !== null && (!Number.isInteger(pagosRecibidos) || pagosRecibidos < 0)) {
    return Errors.validation('pagosRecibidos debe ser un entero mayor o igual a 0.', requestId);
  }
  if (montoEmpresa !== undefined && montoEmpresa !== null && (!Number.isInteger(montoEmpresa) || montoEmpresa < 0)) {
    return Errors.validation('montoEmpresa debe ser un entero mayor o igual a 0.', requestId);
  }

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    `INSERT INTO comisiones_historicas (
       id, venta_id, tipo_registro, beneficiario_email, concepto, distribucion_conocida, pagos_recibidos, importe_pagado,
       monto_empresa, moneda, estado_final, observaciones, nivel_certeza, fecha_exacta, fecha_aproximada, evidencia,
       fuente, declarado_por, confirmado_por_admin
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, venta.id, tipoRegistro, (beneficiarioEmail && beneficiarioEmail.trim().toLowerCase()) || null, concepto || null,
      distribucionConocida || null, pagosRecibidos ?? null, importePagado ?? null, montoEmpresa ?? null, moneda || null,
      estadoFinal || null, observaciones || null, nivelCerteza || null, fechaExacta || null, fechaAproximada || null,
      evidencia || null, fuente.trim(), roleIdentity.email, confirmadoPorAdmin,
    ]
  );
  await logEvento(env.DB, requestId, {
    ventaId: venta.id, entidad: 'comision_historica', entidadId: id, estadoAnterior: null, estadoNuevo: tipoRegistro,
    usuarioEmail: roleIdentity.email,
    motivoNota: `${tipoRegistro}${concepto ? ' — ' + concepto : ''}${beneficiarioEmail ? ' — ' + beneficiarioEmail.trim().toLowerCase() : ''} — fuente: ${fuente.trim()}.`,
  });
  return ok({ id }, requestId, 201);
}
