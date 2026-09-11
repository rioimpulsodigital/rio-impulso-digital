// Sincronización con HubSpot — RIO-120 (11/09/2026, alcance redefinido y
// simplificado por Brenda).
//
// HISTORIA: RIO-117 movió el envío del Kit al backend (Forms API,
// server-to-server). Ese mecanismo fue el que produjo las 2 ventas de
// prueba de Preview que HubSpot marcó como spam ("Dominio de sitio sin
// registrar", *.pages.dev) — un 200 OK de la Forms API nunca garantizó
// contacto creado ni correo entregado. RIO-120 primero reemplazó eso por
// una integración completa con la Objects API (negocios, aplicación
// privada, propiedades nuevas) — Brenda la DESCARTÓ explícitamente
// (11/09/2026) y pidió restaurar el mecanismo ORIGINAL que sí entregaba
// el correo: el envío del formulario "Ficha y Landing Page - RiO" hecho
// DESDE EL NAVEGADOR (como siempre fue, desde RIO-70/71/72), con el
// contexto real de la página y el tracking de HubSpot — nunca desde el
// Worker. Ese envío ahora ocurre en kit-venta-ficha-y-landing-page.html,
// DESPUÉS de que la venta ya quedó guardada en D1 (nunca antes, nunca la
// bloquea).
//
// Este archivo ya NO llama a HubSpot — solo guarda el registro técnico
// mínimo y administrativo del resultado que el navegador reporta
// (pendiente / enviado / error). La infraestructura de la Objects API
// (migración 0032: columnas de negocio, canal 'objects_api', etc.) queda
// intacta pero DEJA DE USARSE — ver migración 0033.

import { query, execute } from './db.js';
import { logEvento } from './historial.js';

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Se llama SIEMPRE al registrar una venta real (no demo, no histórica) —
// deja un rastro durable de que el envío del formulario está pendiente,
// incluso si el navegador nunca llega a confirmarlo (pestaña cerrada,
// etc.). Nunca crea una segunda fila para la misma venta.
export async function crearRegistroPendiente(db, requestId, { ventaId, actorEmail }) {
  const ahora = nowSql();
  const existentes = await query(db, requestId, 'SELECT id FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  if (existentes[0]) return existentes[0].id;
  const id = crypto.randomUUID();
  await execute(
    db, requestId,
    `INSERT INTO hubspot_sync (id, venta_id, estado, canal, intentos, ultimo_intento_at, created_at, updated_at)
     VALUES (?, ?, 'pendiente', 'forms_api_browser', 0, ?, ?, ?)`,
    [id, ventaId, ahora, ahora, ahora]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'hubspot_sync', entidadId: id, estadoAnterior: null, estadoNuevo: 'pendiente',
    usuarioEmail: actorEmail || 'sistema', motivoNota: 'Venta registrada — envío del formulario a HubSpot pendiente (lo hace el navegador).',
  });
  return id;
}

// El navegador llama a esto DESPUÉS de intentar el envío real a HubSpot
// (o de saltarlo deliberadamente en Preview) — nunca al revés. `estado`
// es 'enviado' o 'error' (nunca vuelve a 'pendiente' desde acá). Nunca
// lanza — un problema al registrar el resultado no debe romper nada para
// el vendedor, que ya vio "Venta registrada" antes de este punto.
export async function registrarResultadoEnvioFormulario(db, requestId, { ventaId, estado, resumen, actorEmail }) {
  if (!['enviado', 'error'].includes(estado)) return null;
  const ahora = nowSql();
  const existentes = await query(db, requestId, 'SELECT id, estado, intentos FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  let id;
  if (existentes[0]) {
    // Un envío 'enviado' ya confirmado nunca se pisa con un resultado
    // posterior fuera de orden (ej. una respuesta tardía de un intento
    // viejo) — es terminal.
    if (existentes[0].estado === 'enviado') return existentes[0].id;
    id = existentes[0].id;
    await execute(
      db, requestId,
      "UPDATE hubspot_sync SET estado = ?, canal = 'forms_api_browser', intentos = ?, ultimo_intento_at = ?, ultima_respuesta_resumen = ?, updated_at = ? WHERE id = ?",
      [estado, existentes[0].intentos + 1, ahora, resumen || null, ahora, id]
    );
    await logEvento(db, requestId, {
      ventaId, entidad: 'hubspot_sync', entidadId: id, estadoAnterior: existentes[0].estado, estadoNuevo: estado,
      usuarioEmail: actorEmail || 'sistema', motivoNota: resumen || null,
    });
    return id;
  }
  // No debería faltar (crearRegistroPendiente ya corrió al crear la
  // venta) — pero si falta por algún motivo, se crea igual, nunca se
  // pierde el resultado.
  id = crypto.randomUUID();
  await execute(
    db, requestId,
    `INSERT INTO hubspot_sync (id, venta_id, estado, canal, intentos, ultimo_intento_at, ultima_respuesta_resumen, created_at, updated_at)
     VALUES (?, ?, ?, 'forms_api_browser', 1, ?, ?, ?, ?)`,
    [id, ventaId, estado, ahora, resumen || null, ahora, ahora]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'hubspot_sync', entidadId: id, estadoAnterior: null, estadoNuevo: estado,
    usuarioEmail: actorEmail || 'sistema', motivoNota: resumen || null,
  });
  return id;
}

export async function obtenerEstadoSincronizacion(db, requestId, ventaId) {
  const rows = await query(db, requestId, 'SELECT * FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  return rows[0] || null;
}

// Listado simple para el Panel Administrativo — solo lectura, sin
// acciones de reintento/descarte (Brenda: "panel complejo de
// sincronización... descartado"). Excluye deliberadamente las filas
// legacy/objects_api de la vista por defecto — son historial de
// mecanismos ya retirados, no operación vigente.
export async function listarSincronizaciones(db, requestId, { soloConError = false } = {}) {
  const condiciones = ["hs.canal = 'forms_api_browser'"];
  if (soloConError) condiciones.push("hs.estado = 'error'");
  const sql =
    `SELECT hs.*, v.codigo_venta, v.vendedor_email AS venta_vendedor_email, v.created_at AS venta_created_at, c.negocio
     FROM hubspot_sync hs JOIN ventas v ON v.id = hs.venta_id JOIN clientes c ON c.id = v.cliente_id
     WHERE ${condiciones.join(' AND ')} ORDER BY hs.updated_at DESC`;
  return query(db, requestId, sql, []);
}
