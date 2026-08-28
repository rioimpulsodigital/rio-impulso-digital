// Middleware anidado de /interno/api/identidad/* — RIO-111.
// Cloudflare Pages Functions encadena los _middleware.js del más externo al
// más interno: este corre DESPUÉS de functions/interno/api/_middleware.js
// (que ya validó el JWT de Access — RIO-110 sección 8) y ANTES de cada ruta
// de esta carpeta.
//
// Responsabilidad de este archivo, y solo esta: tomar el email ya verificado
// (`context.data.identity.email`) y resolverlo contra la fuente única de
// autoridad en D1 (rol, mercados autorizados, estado, vigencia — RIO-111).
// Denegación por defecto: si el email no está registrado, no tiene una
// asignación vigente, o está inactivo, la solicitud se rechaza acá — nunca
// llega a la ruta de negocio (whoami.js, usuarios.js, etc.).
//
// Por qué es un middleware separado y no parte del middleware padre: el
// endpoint técnico /interno/api/health (RIO-110) debe seguir funcionando
// solo con Access válido, sin depender de que quien lo llame esté
// registrado en el modelo de negocio de RIO-111 — son capas distintas.

import { resolveRoleIdentity, AuthzError } from '../../../_shared/authz.js';
import { Errors } from '../../../_shared/response.js';

export async function onRequest(context) {
  const { env, data, next } = context;
  const { requestId, identity } = data;

  let roleIdentity;
  try {
    roleIdentity = await resolveRoleIdentity(env.DB, identity.email, requestId);
  } catch (e) {
    if (e instanceof AuthzError) {
      console.warn(JSON.stringify({ requestId, scope: 'authz', reason: e.reason }));
    } else {
      console.error(JSON.stringify({ requestId, scope: 'authz', reason: 'unexpected_error' }));
    }
    return Errors.forbidden(requestId);
  }

  context.data.roleIdentity = roleIdentity;
  return next();
}
