// GET/POST /interno/api/plantillas-distribucion — RIO-119 (tercer bloque,
// item 5, 03/09/2026). Exclusivo de administración.
//
// Una plantilla es un preset reutilizable de los 4 porcentajes (comercial,
// supervisión, desarrollo, empresa — siempre suman 100) que administración
// puede elegir al definir los pools de UN proyecto personalizado concreto
// (`ventas/:id/distribucion`, action 'definir-pools'). La plantilla en sí
// NUNCA se aplica sola a una venta — es solo el punto de partida que
// administración confirma o ajusta.

import { ok, Errors } from '../../../_shared/response.js';
import { query, execute } from '../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../_shared/security.js';
import { logEvento } from '../../../_shared/historial.js';

export function serializePlantilla(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    porcentajeComercial: row.porcentaje_comercial,
    porcentajeSupervision: row.porcentaje_supervision,
    porcentajeDesarrollo: row.porcentaje_desarrollo,
    porcentajeEmpresa: row.porcentaje_empresa,
    estado: row.estado,
    note: row.note || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  if (request.method === 'GET') {
    const rows = await query(env.DB, requestId, 'SELECT * FROM plantillas_distribucion ORDER BY estado ASC, nombre ASC');
    return ok({ plantillas: rows.map(serializePlantilla) }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const { nombre, porcentajeComercial, porcentajeSupervision, porcentajeDesarrollo, porcentajeEmpresa, note } = body || {};
  if (typeof nombre !== 'string' || !nombre.trim()) return Errors.validation('Falta el nombre de la plantilla.', requestId);
  for (const [campo, valor] of [
    ['porcentajeComercial', porcentajeComercial], ['porcentajeSupervision', porcentajeSupervision],
    ['porcentajeDesarrollo', porcentajeDesarrollo], ['porcentajeEmpresa', porcentajeEmpresa],
  ]) {
    if (!Number.isInteger(valor) || valor < 0 || valor > 100) return Errors.validation(`${campo} debe ser un entero entre 0 y 100.`, requestId);
  }
  if (porcentajeComercial + porcentajeSupervision + porcentajeDesarrollo + porcentajeEmpresa !== 100) {
    return Errors.validation('Los 4 porcentajes deben sumar exactamente 100.', requestId);
  }

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    `INSERT INTO plantillas_distribucion (id, nombre, porcentaje_comercial, porcentaje_supervision, porcentaje_desarrollo, porcentaje_empresa, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, nombre.trim(), porcentajeComercial, porcentajeSupervision, porcentajeDesarrollo, porcentajeEmpresa, note || null, roleIdentity.email]
  );
  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'plantilla_distribucion', entidadId: id, estadoAnterior: null, estadoNuevo: 'creada',
    usuarioEmail: roleIdentity.email, motivoNota: `Plantilla "${nombre.trim()}" creada.`,
  });
  return ok({ id }, requestId, 201);
}
