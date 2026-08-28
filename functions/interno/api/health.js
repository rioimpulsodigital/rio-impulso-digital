// GET /interno/api/health — RIO-110 sección 9.
// Endpoint técnico mínimo para verificar la fundación del backend. Requiere
// Access válido (aplicado por _middleware.js) y confirma que D1 responde.
//
// No expone: token, JWT completo, correos, IDs internos, variables de
// entorno, consultas SQL, credenciales ni detalles de infraestructura.

import { ok, Errors } from '../../_shared/response.js';
import { checkConnectivity } from '../../_shared/db.js';
import { isMethodAllowed } from '../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const dbBinding = env.DB;
  const bindingPresent = Boolean(dbBinding);
  const dbConnected = bindingPresent ? await checkConnectivity(dbBinding, requestId) : false;

  const healthy = bindingPresent && dbConnected;

  return ok(
    {
      status: healthy ? 'ok' : 'degraded',
      checks: {
        pagesFunctions: true, // si esto se ejecutó, Pages Functions está operativo.
        access: true, // si esto se ejecutó, el middleware ya validó Access (sección 8).
        d1Binding: bindingPresent,
        d1Connectivity: dbConnected,
      },
    },
    requestId,
    healthy ? 200 : 503
  );
}
