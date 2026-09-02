// GET /interno/api/identidad/referente — RIO-118 (corrección, decisiones
// de Brenda sobre identidad visible, equipos y referente comercial,
// 01/09/2026).
//
// Devuelve, para CADA equipo del que quien llama es miembro VIGENTE, el
// supervisor PRINCIPAL vigente de ese equipo — "Mi referente comercial"
// del Panel del Vendedor. Deliberadamente no acepta ningún parámetro
// (usuario, equipo, mercado) del cliente: siempre resuelve exclusivamente
// sobre la sesión ya autenticada (`roleIdentity.email`), así que no existe
// ningún ID que un usuario pueda manipular para pedir el referente de
// otra persona — la superficie de ataque que Brenda pidió cerrar
// explícitamente queda cerrada por diseño, no por una validación aparte.
//
// El WhatsApp laboral SOLO viaja en la respuesta cuando: (a) hay un
// supervisor principal vigente, (b) esa persona no es quien llama (un
// supervisor no necesita un botón para escribirse a sí mismo), y (c) el
// campo está configurado en D1 — nunca se inventa ni se completa desde un
// archivo del frontend. Ninguna otra información (documento, correo
// privado, datos bancarios) se expone acá.

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { isMethodAllowed } from '../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const equipos = await query(
    env.DB, requestId,
    `SELECT em.equipo_id, e.nombre AS equipo_nombre, e.mercado
     FROM equipo_miembros em JOIN equipos e ON e.id = em.equipo_id
     WHERE em.usuario_email = ? AND (em.valid_until IS NULL OR em.valid_until > datetime('now')) AND em.valid_from <= datetime('now')
     ORDER BY e.mercado, e.nombre`,
    [roleIdentity.email]
  );

  const referentes = await Promise.all(equipos.map(async (eq) => {
    const supRows = await query(
      env.DB, requestId,
      `SELECT es.usuario_email, u.id AS usuario_id, u.nombre, u.whatsapp_laboral
       FROM equipo_supervisores es LEFT JOIN usuarios u ON u.email = es.usuario_email
       WHERE es.equipo_id = ? AND es.es_principal = 1
         AND (es.valid_until IS NULL OR es.valid_until > datetime('now')) AND es.valid_from <= datetime('now')
       ORDER BY es.valid_from DESC LIMIT 1`,
      [eq.equipo_id]
    );
    const sup = supRows[0];
    const base = { equipoId: eq.equipo_id, equipoNombre: eq.equipo_nombre, mercado: eq.mercado };

    if (!sup) {
      return { ...base, supervisorId: null, supervisorNombre: null, esUnoMismo: false, whatsappLaboral: null, disponibilidad: 'sin_supervisor' };
    }

    const esUnoMismo = sup.usuario_email === roleIdentity.email;
    return {
      ...base,
      supervisorId: sup.usuario_id || null,
      supervisorNombre: sup.nombre || null,
      esUnoMismo,
      whatsappLaboral: (!esUnoMismo && sup.whatsapp_laboral) ? sup.whatsapp_laboral : null,
      disponibilidad: esUnoMismo ? 'uno_mismo' : (sup.whatsapp_laboral ? 'configurado' : 'pendiente'),
    };
  }));

  return ok({ referentes }, requestId);
}
