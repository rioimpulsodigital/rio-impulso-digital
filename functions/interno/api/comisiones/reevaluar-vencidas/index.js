// POST /interno/api/comisiones/reevaluar-vencidas — RIO-122, TEMPORAL.
//
// ⚠️ SOLO PARA UAT DE LIQUIDACIONES EN PREVIEW — RETIRAR ANTES DE MERGEAR
// A main. workers/comisiones-cron/ es el mecanismo real y permanente
// pensado para esto (RIO-123, requiere autorización formal de
// infraestructura de Producción — ver su propio README). Esta ruta existe
// únicamente porque hoy no hay ningún cron activo en Preview y hace falta
// disparar la reevaluación real al menos una vez para destrabar el UAT
// del flujo de Liquidaciones, sin desplegar el Worker independiente
// todavía.
//
// No reimplementa nada: llama exactamente a la misma función que ya usa
// (o usaría) el cron real — reevaluarComisionesVencidasDelSistema(), que
// a su vez reutiliza evaluateComisionGate() sin ninguna segunda
// implementación. Reevalúa TODAS las comisiones 'calculada_provisional'/
// 'retenida' del sistema (mismo comportamiento que tendría el cron real),
// no solo una — eso es el diseño original de la función, no algo que
// esta ruta agregue.
//
// Protegida por la misma identidad/rol de administración que ya usa el
// resto de /interno/api/* (Cloudflare Access + requireRoleIdentity) — sin
// secreto nuevo, sin binding nuevo.

import { ok, Errors } from '../../../../_shared/response.js';
import { isMethodAllowed } from '../../../../_shared/security.js';
import { reevaluarComisionesVencidasDelSistema } from '../../../../_shared/comisiones.js';

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  if (!roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }

  const resultado = await reevaluarComisionesVencidasDelSistema(env.DB, requestId);
  return ok(resultado, requestId);
}
