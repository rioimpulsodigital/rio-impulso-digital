// Worker independiente — RIO-122 (15/09/2026, reevaluación automática de
// comisiones por vencimiento del plazo de resguardo).
//
// Por qué un Worker aparte, en vez de un endpoint dentro del Pages
// Function existente: Cloudflare Pages Functions solo se ejecutan en
// respuesta a una solicitud HTTP — no soportan un export `scheduled()`
// (eso es exclusivo de Workers "clásicos", ver docs de Cron Triggers).
// La alternativa habitual (un endpoint HTTP que un cron externo llama)
// exigía exponer una ruta que reevalúa estado financiero fuera del
// control de Cloudflare Access — este Worker en cambio se conecta
// DIRECTO al mismo binding D1 (misma base, `rio-ventas-preview`) y
// reutiliza la función exacta que ya evalúa el gate de habilitación
// (`evaluateComisionGate`, vía `reevaluarComisionesVencidasDelSistema` en
// functions/_shared/comisiones.js) — nunca una segunda implementación,
// nunca un secreto compartido ni una ruta pública nueva que proteger.
//
// No se despliega como parte de esta corrección — ver README de esta
// carpeta para el procedimiento de activación (pensado para RIO-123).

import { reevaluarComisionesVencidasDelSistema } from '../../functions/_shared/comisiones.js';

export default {
  async scheduled(event, env, ctx) {
    const requestId = 'cron-' + event.scheduledTime;
    try {
      const resultado = await reevaluarComisionesVencidasDelSistema(env.DB, requestId);
      console.log(JSON.stringify({ requestId, scope: 'comisiones-cron', ...resultado }));
    } catch (e) {
      console.error(JSON.stringify({ requestId, scope: 'comisiones-cron', reason: 'reevaluacion_fallida' }));
      throw e; // deja el intento visible como fallido en Cloudflare — nunca falla en silencio.
    }
  },

  // POST manual, exclusivamente para verificar en Preview que el Worker y
  // el binding D1 funcionan antes de confiar en el disparo programado —
  // este Worker vive en su propio subdominio (nunca bajo rioimpulsodigital.com),
  // así que el gate de Cloudflare Access de /interno/ no aplica acá; en su
  // lugar exige un secreto propio (`MANUAL_TRIGGER_SECRET`, ver README) —
  // nunca queda abierto a cualquiera en internet, aunque el único efecto
  // posible de llamarlo sea reevaluar (de forma idempotente) comisiones
  // que igual iban a reevaluarse solas.
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Método no permitido — usar POST para forzar una corrida manual de verificación.', { status: 405 });
    }
    const secretoEsperado = env.MANUAL_TRIGGER_SECRET;
    const secretoRecibido = request.headers.get('X-Manual-Trigger-Secret');
    if (!secretoEsperado || secretoRecibido !== secretoEsperado) {
      return new Response('No autorizado.', { status: 401 });
    }
    const requestId = 'manual-' + Date.now();
    const resultado = await reevaluarComisionesVencidasDelSistema(env.DB, requestId);
    return new Response(JSON.stringify({ ok: true, requestId, ...resultado }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
