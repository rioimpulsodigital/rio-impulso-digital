// GET/POST /interno/api/planes-comision — RIO-119 (tercer bloque, item 2,
// 02/09/2026). Exclusivo de administración.
//
// Un plan es una DEFINICIÓN (tipo, porcentaje, base, alcance de
// producto/mercado) — nunca se asigna solo por crearse. La asignación a una
// persona es un paso aparte (`/planes-comision/:id/asignaciones`, RIO-119
// item 3), igual que el patrón ya usado en `asignaciones_rol` y
// `equipo_supervisores`. Ningún cambio acá recalcula comisiones ya
// generadas — `comisiones.js` guarda un snapshot del porcentaje al crear
// cada comisión (`porcentaje_snapshot`), por eso un plan puede cambiar
// libremente hacia adelante sin tocar el pasado.
//
// GET: lista todos los planes (activos e inactivos — la vigencia pasada
// también es información útil para administración, "consultar versiones
// anteriores").
// POST: crea un plan nuevo, siempre inactivo hasta... no: nace 'activo' por
// defecto (igual que el resto de las entidades vigentes del panel), pero
// nunca se aplica a ventas ya registradas — solo a asignaciones futuras.

import { ok, Errors } from '../../../_shared/response.js';
import { query, execute } from '../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../_shared/security.js';
import { logEvento } from '../../../_shared/historial.js';

const TIPOS_VALIDOS = ['comercial', 'supervision', 'produccion', 'realizacion', 'desarrollo'];
const CONTEXTOS_VALIDOS = ['solo', 'responsable_con_practicante', 'practicante'];
const BASES_VALIDAS = ['utilidad_neta_venta', 'utilidad_neta_componente'];

export function serializePlan(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    contextoRealizacion: row.contexto_realizacion || null,
    porcentaje: row.porcentaje,
    base: row.base,
    productosAlcanzados: JSON.parse(row.productos_alcanzados),
    mercadosAlcanzados: JSON.parse(row.mercados_alcanzados),
    estado: row.estado,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    note: row.note || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function validarProductosMercados(productos, mercados) {
  if (!Array.isArray(productos) || productos.length === 0) return 'productosAlcanzados debe ser un arreglo no vacío.';
  if (!productos.every((p) => typeof p === 'string' && p.trim())) return 'productosAlcanzados debe contener solo strings.';
  if (!Array.isArray(mercados) || mercados.length === 0) return 'mercadosAlcanzados debe ser un arreglo no vacío.';
  if (!mercados.every((m) => typeof m === 'string' && m.trim())) return 'mercadosAlcanzados debe contener solo strings.';
  return null;
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  if (request.method === 'GET') {
    const rows = await query(env.DB, requestId, 'SELECT * FROM planes_comision ORDER BY tipo ASC, valid_from DESC');
    return ok({ planes: rows.map(serializePlan) }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const { tipo, contextoRealizacion, porcentaje, base, productosAlcanzados, mercadosAlcanzados, note } = body || {};

  if (!TIPOS_VALIDOS.includes(tipo)) return Errors.validation(`tipo inválido. Valores permitidos: ${TIPOS_VALIDOS.join(', ')}.`, requestId);
  if (contextoRealizacion !== undefined && contextoRealizacion !== null && !CONTEXTOS_VALIDOS.includes(contextoRealizacion)) {
    return Errors.validation(`contextoRealizacion inválido. Valores permitidos: ${CONTEXTOS_VALIDOS.join(', ')}.`, requestId);
  }
  if (tipo === 'realizacion' && !contextoRealizacion) {
    return Errors.validation('Un plan de tipo realizacion requiere contextoRealizacion (solo, responsable_con_practicante o practicante).', requestId);
  }
  if (tipo !== 'realizacion' && contextoRealizacion) {
    return Errors.validation('contextoRealizacion solo aplica a planes de tipo realizacion.', requestId);
  }
  if (!Number.isInteger(porcentaje) || porcentaje < 0 || porcentaje > 100) {
    return Errors.validation('porcentaje debe ser un entero entre 0 y 100.', requestId);
  }
  if (!BASES_VALIDAS.includes(base)) return Errors.validation(`base inválida. Valores permitidos: ${BASES_VALIDAS.join(', ')}.`, requestId);
  const errorAlcance = validarProductosMercados(productosAlcanzados, mercadosAlcanzados);
  if (errorAlcance) return Errors.validation(errorAlcance, requestId);

  const id = crypto.randomUUID();
  await execute(
    env.DB, requestId,
    `INSERT INTO planes_comision (id, tipo, contexto_realizacion, porcentaje, base, productos_alcanzados, mercados_alcanzados, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tipo, contextoRealizacion || null, porcentaje, base, JSON.stringify(productosAlcanzados), JSON.stringify(mercadosAlcanzados), note || null, roleIdentity.email]
  );
  await logEvento(env.DB, requestId, {
    ventaId: null, entidad: 'plan_comision', entidadId: id, estadoAnterior: null, estadoNuevo: 'creado',
    usuarioEmail: roleIdentity.email, motivoNota: `Plan ${tipo} ${porcentaje}% creado.`,
  });
  return ok({ id }, requestId, 201);
}
