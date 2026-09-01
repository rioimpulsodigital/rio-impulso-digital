// Sincronización con HubSpot al cerrar una venta — RIO-117 (segundo
// bloque, 01/09/2026).
//
// ALCANCE DELIBERADAMENTE LIMITADO — leer antes de tocar este archivo:
// esto NO es la integración segura server-to-server de RIO-120 (token
// privado del Worker, asociación real de objetos/deals, reintento
// administrado con backoff). Esto es el CONTRATO mínimo para que "Cerrar
// venta" del Kit deje de escribir en HubSpot directo desde el navegador
// sin ningún control — ahora D1 se escribe primero (fuente de verdad
// operativa), y recién si eso tuvo éxito se reintenta lo mismo que el
// Kit ya hacía: un POST al mismo endpoint PÚBLICO de HubSpot Forms API
// que el Kit ya usaba (portalId/formGuid no son secretos — ya viajaban
// visibles en el HTML del Kit; acá no se agrega ningún token nuevo).
//
// Cuando RIO-120 se implemente, esta función se reemplaza por la
// integración real (probablemente Objects API con un token privado del
// Worker) — el contrato de `hubspot_sync` (estado, intentos, resumen) no
// debería necesitar cambiar, solo quién y cómo hace el POST real.
//
// LIMITACIÓN DOCUMENTADA (no resuelta, no corresponde a RIO-117): la
// HubSpot Forms API no expone una clave de idempotencia propia — un
// reintento manual vuelve a enviar el mismo formulario. HubSpot
// típicamente actualiza el contacto existente por email en vez de crear
// uno duplicado, pero esta integración NO lo verifica ni lo garantiza
// (no hay forma de confirmarlo sin credenciales de administrador de
// HubSpot, fuera del alcance actual) — un reintento podría dejar más de
// un registro de envío de formulario asociado al mismo contacto. Esto es
// exactamente el tipo de caso que RIO-120 debe resolver con la API de
// Objects/asociaciones, no la Forms API.

import { query, execute } from './db.js';

const HUBSPOT_PORTAL_ID = '51671122';
const HUBSPOT_FORM_GUID = 'cb4cb2df-ca0f-42ee-bf54-a0830e8ba6a5';
const HUBSPOT_ENDPOINT = `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_GUID}`;

async function registrarIntento(db, requestId, ventaId, estado, resumen) {
  const existentes = await query(db, requestId, 'SELECT id, intentos FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (existentes[0]) {
    await execute(
      db, requestId,
      'UPDATE hubspot_sync SET estado = ?, intentos = ?, ultima_respuesta_resumen = ?, updated_at = ? WHERE id = ?',
      [estado, existentes[0].intentos + 1, resumen || null, ahora, existentes[0].id]
    );
    return existentes[0].id;
  }
  const id = crypto.randomUUID();
  await execute(
    db, requestId,
    'INSERT INTO hubspot_sync (id, venta_id, estado, intentos, ultima_respuesta_resumen, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    [id, ventaId, estado, resumen || null, ahora]
  );
  return id;
}

// `fields`/`context` son exactamente lo que el Kit ya construía en el
// navegador (misma forma que espera HubSpot Forms API) — este módulo
// nunca decide qué campos mandar ni interpreta su contenido, solo lo
// reenvía. Nunca bloquea ni revierte la venta ya creada en D1 si esto
// falla — es una consecuencia posterior, no un requisito para cerrar la
// venta (mismo principio que la generación de comisiones al registrar
// una venta, RIO-114).
export async function intentarSincronizarHubSpot(db, requestId, { ventaId, fields, context }) {
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    return { estado: 'pendiente', resumen: 'sin_campos_para_enviar' };
  }
  try {
    const response = await fetch(HUBSPOT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, context: context || {} }),
    });
    if (!response.ok) {
      const resumen = `http_${response.status}`;
      await registrarIntento(db, requestId, ventaId, 'fallido', resumen);
      console.error(JSON.stringify({ requestId, scope: 'hubspot_sync', reason: 'submit_fallido', ventaId, status: response.status }));
      return { estado: 'fallido', resumen };
    }
    await registrarIntento(db, requestId, ventaId, 'exitoso', 'ok');
    return { estado: 'exitoso', resumen: 'ok' };
  } catch (e) {
    await registrarIntento(db, requestId, ventaId, 'fallido', 'error_red');
    console.error(JSON.stringify({ requestId, scope: 'hubspot_sync', reason: 'submit_excepcion', ventaId }));
    return { estado: 'fallido', resumen: 'error_red' };
  }
}

export async function obtenerEstadoSincronizacion(db, requestId, ventaId) {
  const rows = await query(db, requestId, 'SELECT * FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  return rows[0] || null;
}
