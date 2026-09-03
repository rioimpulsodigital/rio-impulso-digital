// GET/POST /interno/api/ventas/:id/comisiones-historicas — RIO-119 (cuarto
// bloque, 03/09/2026). Exclusivo de administración, solo aplica a ventas
// marcadas como importación histórica (modo_historico no nulo).
//
// TABLA SEPARADA de `comisiones` (ver migración 0029 para la auditoría
// completa de alternativas) — estructuralmente invisible para toda la
// máquina de estados de comisiones: nunca entra al calendario 10/25,
// nunca dispara notificaciones, nunca se recalcula con planes vigentes,
// nunca genera deuda actual ni altera liquidaciones vigentes. Solo
// registra lo que ya se pagó ANTES de que el proyecto se incorporara a
// este sistema — un dato de referencia auditado, no una operación viva.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query, execute } from '../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../_shared/security.js';
import { logEvento } from '../../../../../_shared/historial.js';

const VALID_CONCEPTOS = ['comercial', 'supervision', 'desarrollo', 'realizacion', 'produccion'];
const VALID_MONEDAS = ['CLP', 'ARS'];

function serialize(row) {
  return {
    id: row.id,
    beneficiarioEmail: row.beneficiario_email,
    concepto: row.concepto,
    importePagado: row.importe_pagado,
    moneda: row.moneda,
    fechaExacta: row.fecha_exacta || null,
    fechaAproximada: row.fecha_aproximada || null,
    evidencia: row.evidencia || null,
    estado: row.estado,
    fuente: row.fuente,
    declaradoPor: row.declarado_por,
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

  const { beneficiarioEmail, concepto, importePagado, moneda, fechaExacta, fechaAproximada, evidencia, fuente } = body || {};
  if (typeof beneficiarioEmail !== 'string' || !beneficiarioEmail.trim()) return Errors.validation('Falta beneficiarioEmail.', requestId);
  if (!VALID_CONCEPTOS.includes(concepto)) return Errors.validation(`concepto inválido. Valores permitidos: ${VALID_CONCEPTOS.join(', ')}.`, requestId);
  if (!Number.isInteger(importePagado) || importePagado < 0) return Errors.validation('importePagado debe ser un entero mayor o igual a 0.', requestId);
  if (!VALID_MONEDAS.includes(moneda)) return Errors.validation(`moneda inválida. Valores permitidos: ${VALID_MONEDAS.join(', ')}.`, requestId);
  if (!fechaExacta && !fechaAproximada) return Errors.validation('Se requiere fechaExacta o fechaAproximada (al menos una).', requestId);
  if (typeof fuente !== 'string' || !fuente.trim()) return Errors.validation('Falta fuente (de dónde se obtuvo este dato).', requestId);

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    `INSERT INTO comisiones_historicas (id, venta_id, beneficiario_email, concepto, importe_pagado, moneda, fecha_exacta, fecha_aproximada, evidencia, fuente, declarado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, venta.id, beneficiarioEmail.trim().toLowerCase(), concepto, importePagado, moneda, fechaExacta || null, fechaAproximada || null, evidencia || null, fuente.trim(), roleIdentity.email]
  );
  await logEvento(env.DB, requestId, {
    ventaId: venta.id, entidad: 'comision_historica', entidadId: id, estadoAnterior: null, estadoNuevo: 'historica_pagada_antes_incorporacion',
    usuarioEmail: roleIdentity.email, motivoNota: `${concepto} — ${beneficiarioEmail.trim().toLowerCase()} — fuente: ${fuente.trim()}.`,
  });
  return ok({ id }, requestId, 201);
}
