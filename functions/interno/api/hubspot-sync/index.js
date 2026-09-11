// GET /interno/api/hubspot-sync — RIO-120 (11/09/2026, alcance
// simplificado por Brenda). Vista de solo lectura del resultado del envío
// del formulario de HubSpot ("Ficha y Landing Page - RiO") por venta —
// exclusivo de administración. Deliberadamente sin acciones de
// reintentar/descartar (Brenda: "panel complejo de sincronización...
// descartado") — si un envío falló, se resuelve conversando con el
// vendedor o reabriendo el Kit, nunca desde acá. El vendedor nunca accede
// a esta ruta ni ve nada de esto (panel-vendedor.js no la lee).

import { ok, Errors } from '../../../_shared/response.js';
import { isMethodAllowed } from '../../../_shared/security.js';
import { listarSincronizaciones } from '../../../_shared/hubspot.js';

function serialize(row) {
  return {
    id: row.id,
    ventaId: row.venta_id,
    codigoVenta: row.codigo_venta,
    clienteNegocio: row.negocio,
    vendedorEmail: row.venta_vendedor_email,
    ventaCreatedAt: row.venta_created_at,
    estado: row.estado,
    intentos: row.intentos,
    ultimoIntentoAt: row.ultimo_intento_at,
    resumen: row.ultima_respuesta_resumen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const url = new URL(request.url);
  const soloConError = url.searchParams.get('conError') === '1';
  const rows = await listarSincronizaciones(env.DB, requestId, { soloConError });
  return ok({ sincronizaciones: rows.map(serialize) }, requestId);
}
