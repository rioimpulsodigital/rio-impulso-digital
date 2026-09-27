// POST /interno/api/planes-comision/:id — RIO-119 (tercer bloque, item 2,
// 02/09/2026). Exclusivo de administración.
//
// action 'desactivar': cierra el plan (estado='inactivo', valid_until=ahora)
//   sin reemplazo — deja de poder asignarse a operaciones futuras. Las
//   asignaciones y comisiones ya generadas con este plan no se tocan
//   (snapshot inmutable en `comisiones.porcentaje_snapshot`).
// action 'nueva-version': "cambiar porcentajes para operaciones futuras,
//   consultar versiones anteriores" (Brenda, RIO-119 tercer bloque) — nunca
//   muta el porcentaje de un plan existente in place. Cierra el plan actual
//   (mismo criterio que 'desactivar') y crea uno nuevo con los campos
//   indicados (por defecto hereda tipo/contexto/base/alcance del anterior,
//   solo el/los campos enviados cambian) — el plan viejo queda consultable
//   como historial, nunca se sobrescribe.

import { ok, Errors } from '../../../../_shared/response.js';
import { query, execute } from '../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { logEvento } from '../../../../_shared/historial.js';
import { serializePlan } from '../index.js';

const CONTEXTOS_VALIDOS = ['solo', 'responsable_con_practicante', 'practicante'];
const BASES_VALIDAS = ['utilidad_neta_venta', 'utilidad_neta_componente'];

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  const rows = await query(env.DB, requestId, 'SELECT * FROM planes_comision WHERE id = ?', [params.id]);
  const plan = rows[0];
  if (!plan) return Errors.notFound(requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action === 'desactivar') {
    if (plan.estado === 'inactivo') return Errors.validation('El plan ya está inactivo.', requestId);
    await execute(env.DB, requestId, "UPDATE planes_comision SET estado = 'inactivo', valid_until = datetime('now') WHERE id = ?", [plan.id]);
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'plan_comision', entidadId: plan.id, estadoAnterior: 'activo', estadoNuevo: 'inactivo',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || 'Plan desactivado.',
    });
    return ok({ id: plan.id, estado: 'inactivo' }, requestId);
  }

  if (body?.action === 'nueva-version') {
    const { porcentaje, base, productosAlcanzados, mercadosAlcanzados, note } = body;
    const nuevoPorcentaje = porcentaje !== undefined ? porcentaje : plan.porcentaje;
    if (!Number.isInteger(nuevoPorcentaje) || nuevoPorcentaje < 0 || nuevoPorcentaje > 100) {
      return Errors.validation('porcentaje debe ser un entero entre 0 y 100.', requestId);
    }
    const nuevaBase = base !== undefined ? base : plan.base;
    if (!BASES_VALIDAS.includes(nuevaBase)) return Errors.validation(`base inválida. Valores permitidos: ${BASES_VALIDAS.join(', ')}.`, requestId);
    const nuevosProductos = productosAlcanzados !== undefined ? productosAlcanzados : JSON.parse(plan.productos_alcanzados);
    const nuevosMercados = mercadosAlcanzados !== undefined ? mercadosAlcanzados : JSON.parse(plan.mercados_alcanzados);
    if (!Array.isArray(nuevosProductos) || nuevosProductos.length === 0 || !Array.isArray(nuevosMercados) || nuevosMercados.length === 0) {
      return Errors.validation('productosAlcanzados y mercadosAlcanzados deben ser arreglos no vacíos.', requestId);
    }

    const nuevoId = crypto.randomUUID();
    await execute(env.DB, requestId, "UPDATE planes_comision SET estado = 'inactivo', valid_until = datetime('now') WHERE id = ?", [plan.id]);
    await execute(
      env.DB, requestId,
      `INSERT INTO planes_comision (id, tipo, contexto_realizacion, porcentaje, base, productos_alcanzados, mercados_alcanzados, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nuevoId, plan.tipo, plan.contexto_realizacion, nuevoPorcentaje, nuevaBase, JSON.stringify(nuevosProductos), JSON.stringify(nuevosMercados), note !== undefined ? note : plan.note, roleIdentity.email]
    );
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'plan_comision', entidadId: nuevoId, estadoAnterior: null, estadoNuevo: 'nueva_version',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || `Nueva versión del plan ${plan.id} (${plan.porcentaje}% → ${nuevoPorcentaje}%). Aplica solo a operaciones futuras.`,
    });
    await logEvento(env.DB, requestId, {
      ventaId: null, entidad: 'plan_comision', entidadId: plan.id, estadoAnterior: 'activo', estadoNuevo: 'reemplazado',
      usuarioEmail: roleIdentity.email, motivoNota: `Reemplazado por la nueva versión ${nuevoId}.`,
    });

    const nuevoRows = await query(env.DB, requestId, 'SELECT * FROM planes_comision WHERE id = ?', [nuevoId]);
    return ok({ plan: serializePlan(nuevoRows[0]) }, requestId, 201);
  }

  return Errors.validation('action inválida. Valores permitidos: desactivar, nueva-version.', requestId);
}
