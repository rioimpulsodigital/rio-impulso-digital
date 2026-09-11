// GET /interno/api/hubspot-sync — RIO-120 (11/09/2026). Lista el estado de
// sincronización con HubSpot de cada venta — exclusivo de administración
// (Brenda: "solo Administración puede ver errores técnicos... el vendedor
// nunca ve estados técnicos de HubSpot"). El vendedor sigue viendo
// únicamente que su venta quedó registrada (ver el Kit y panel-vendedor.js,
// que nunca leen esto).
//
// Nunca expone la respuesta cruda de HubSpot — solo el resumen ya
// saneado que guarda functions/_shared/hubspot.js.

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
    canal: row.canal,
    intentos: row.intentos,
    ultimoIntentoAt: row.ultimo_intento_at,
    proximoReintentoAt: row.proximo_reintento_at,
    resumen: row.ultima_respuesta_resumen,
    hubspotContactId: row.hubspot_contact_id,
    hubspotDealId: row.hubspot_deal_id,
    motivoDescarte: row.motivo_descarte,
    descartadoPor: row.descartado_por,
    descartadoAt: row.descartado_at,
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
