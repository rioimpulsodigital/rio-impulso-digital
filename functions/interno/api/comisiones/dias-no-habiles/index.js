// GET/POST /interno/api/comisiones/dias-no-habiles — RIO-114.
// Calendario de días no hábiles por mercado, administrable y auditable
// (Brenda: "no hardcodear feriados indefinidamente") — usado por
// calcularFechaProgramada() para ajustar la fecha de pago de una comisión.
// Alta exclusiva de administración; la lectura no expone datos financieros,
// así que no hace falta restringirla más que "usuario identificado".

import { ok, Errors } from '../../../../_shared/response.js';
import { query, execute } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';

const VALID_MERCADOS = ['CL', 'AR'];

async function handleList(context) {
  const { env, data } = context;
  const { requestId } = data;
  const rows = await query(env.DB, requestId, 'SELECT * FROM dias_no_habiles ORDER BY fecha', []);
  return ok({
    diasNoHabiles: rows.map((r) => ({ id: r.id, mercado: r.mercado, fecha: r.fecha, motivo: r.motivo, createdBy: r.created_by })),
  }, requestId);
}

async function handleCreate(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }
  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }
  if (!VALID_MERCADOS.includes(body?.mercado)) {
    return Errors.validation('Mercado inválido.', requestId);
  }
  if (typeof body.fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha)) {
    return Errors.validation('fecha inválida — formato esperado YYYY-MM-DD.', requestId);
  }
  if (typeof body.motivo !== 'string' || !body.motivo.trim()) {
    return Errors.validation('Falta el motivo del día no hábil.', requestId);
  }

  const id = crypto.randomUUID();
  try {
    await execute(
      env.DB, requestId,
      'INSERT INTO dias_no_habiles (id, mercado, fecha, motivo, created_by) VALUES (?, ?, ?, ?, ?)',
      [id, body.mercado, body.fecha, body.motivo.trim(), roleIdentity.email]
    );
  } catch (e) {
    return Errors.validation('Ya existe un día no hábil registrado para ese mercado y esa fecha.', requestId);
  }

  return ok({ id }, requestId, 201);
}

export async function onRequest(context) {
  const { request, data } = context;
  const { requestId } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  return request.method === 'GET' ? handleList(context) : handleCreate(context);
}
