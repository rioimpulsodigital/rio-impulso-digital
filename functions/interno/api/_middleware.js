// Middleware de /interno/api/* — RIO-110 sección 3/8/11.
// Se aplica automáticamente (convención de Cloudflare Pages Functions) a
// toda ruta dentro de esta carpeta y sus subcarpetas.
//
// Orden de responsabilidades, en este mismo archivo:
//   1. Generar un requestId para toda la solicitud (diagnóstico, sección 7/10).
//   2. Responder preflight CORS (OPTIONS) sin llegar a autenticación.
//   3. Verificar el JWT de Access del lado servidor — denegación por defecto:
//      si no valida, la solicitud NUNCA llega a la ruta de negocio.
//   4. Dejar `identity` y `requestId` disponibles en `context.data` para que
//      cada ruta los use sin volver a validar nada.
//   5. Envolver la ruta en try/catch: cualquier error no controlado se
//      responde como INTERNAL_ERROR genérico — nunca un stack trace al cliente.
//   6. Agregar los headers de CORS correspondientes a la respuesta final.

import { verifyAccessRequest, AccessValidationError } from '../../_shared/access.js';
import { newRequestId, Errors } from '../../_shared/response.js';
import { corsHeaders } from '../../_shared/security.js';

export async function onRequest(context) {
  const { request, next, env } = context;
  const requestId = newRequestId();
  const cors = corsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'X-Request-Id': requestId } });
  }

  let identity;
  try {
    identity = await verifyAccessRequest(request, env);
  } catch (e) {
    // La razón interna (AccessValidationError.reason) se registra para
    // diagnóstico propio, nunca se traduce al mensaje que recibe el cliente.
    if (e instanceof AccessValidationError) {
      console.warn(JSON.stringify({ requestId, scope: 'access', reason: e.reason }));
    } else {
      console.error(JSON.stringify({ requestId, scope: 'access', reason: 'unexpected_error' }));
    }
    return Errors.unauthenticated(requestId, cors);
  }

  context.data.requestId = requestId;
  context.data.identity = identity;

  try {
    const response = await next();
    for (const [key, value] of Object.entries(cors)) {
      response.headers.set(key, value);
    }
    if (!response.headers.get('X-Request-Id')) {
      response.headers.set('X-Request-Id', requestId);
    }
    return response;
  } catch (e) {
    console.error(JSON.stringify({ requestId, scope: 'route', reason: 'unhandled_exception' }));
    return Errors.internal(requestId, cors);
  }
}
