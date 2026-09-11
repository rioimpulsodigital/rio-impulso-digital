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

// RIO-120 (11/09/2026, corrección de confiabilidad): mismos portalId/
// formGuid fijos que ya usa el Kit en el navegador — nunca secretos (ya
// viajaban visibles en el HTML desde RIO-70). Se duplican acá SOLO para
// el fallback server-side de administración (ver enviarFormularioServerSide
// más abajo) — el envío normal de cada venta sigue siendo responsabilidad
// exclusiva del navegador.
const HUBSPOT_PORTAL_ID = '51671122';
const HUBSPOT_FORM_GUID = 'cb4cb2df-ca0f-42ee-bf54-a0830e8ba6a5';
const HUBSPOT_FORMS_ENDPOINT = `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_GUID}`;
const PAGINA_KIT_PRODUCCION = 'https://rioimpulsodigital.com/interno/kit-venta-ficha-y-landing-page.html';

// Cuánto dura la "reserva" de un intento en curso antes de considerarse
// abandonado (pestaña cerrada, red caída a mitad de camino, etc.) y volver
// a quedar disponible para un nuevo intento — nunca bloqueado para
// siempre. 2 minutos es más que suficiente para un POST real a HubSpot.
const LEASE_MS = 2 * 60 * 1000;

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function sqlHaceMs(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
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

// RIO-120 (11/09/2026, corrección de confiabilidad): autoriza (o no) UN
// intento de envío — la única puerta real para decidir "¿puedo enviar
// ahora?", resuelta siempre en el backend contra el registro mínimo de
// sincronización, NUNCA solo por una variable del navegador (ej. si la
// creación de la venta fue o no un replay). Se llama SIEMPRE que el Kit
// confirma una venta (creación nueva o replay) — así un intento que
// falló en una confirmación anterior se reintenta solo, sin esperar una
// acción manual.
//
// El UPDATE condicional es la única fuente de atomicidad: SQLite/D1
// serializa las escrituras a una misma fila, así que dos solicitudes
// "concurrentes" (dos pestañas, o el navegador y un reintento de
// administración a la vez) nunca pueden ganar la carrera las dos — se
// revisa `meta.changes` para saber si ESTA llamada fue la que ganó.
// 'enviado' es terminal (nunca se reclama de nuevo). 'procesando' con el
// lease todavía vigente tampoco se reclama (alguien más ya está
// intentando). 'procesando' con el lease vencido (intento abandonado —
// pestaña cerrada, timeout) SÍ vuelve a quedar disponible.
export async function reclamarIntentoEnvio(db, requestId, { ventaId, actorEmail }) {
  const ahora = nowSql();
  const limiteLease = sqlHaceMs(LEASE_MS);

  const existentes = await query(db, requestId, 'SELECT id, estado FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  if (!existentes[0]) {
    // No debería faltar (crearRegistroPendiente ya corrió al crear la
    // venta) — si falta por algún motivo, se crea directamente en
    // 'procesando', reservando el intento de una.
    const id = crypto.randomUUID();
    await execute(
      db, requestId,
      `INSERT INTO hubspot_sync (id, venta_id, estado, canal, intentos, ultimo_intento_at, created_at, updated_at)
       VALUES (?, ?, 'procesando', 'forms_api_browser', 1, ?, ?, ?)`,
      [id, ventaId, ahora, ahora, ahora]
    );
    return { autorizado: true, id };
  }

  const fila = existentes[0];
  if (fila.estado === 'enviado') return { autorizado: false, motivo: 'ya_enviado', id: fila.id };

  const resultado = await execute(
    db, requestId,
    `UPDATE hubspot_sync SET estado = 'procesando', intentos = intentos + 1, ultimo_intento_at = ?, updated_at = ?
     WHERE venta_id = ? AND (estado IN ('pendiente', 'error') OR (estado = 'procesando' AND ultimo_intento_at <= ?))`,
    [ahora, ahora, ventaId, limiteLease]
  );
  const gano = (resultado?.meta?.changes || 0) > 0;
  if (!gano) return { autorizado: false, motivo: 'intento_en_curso', id: fila.id };

  await logEvento(db, requestId, {
    ventaId, entidad: 'hubspot_sync', entidadId: fila.id, estadoAnterior: fila.estado, estadoNuevo: 'procesando',
    usuarioEmail: actorEmail || 'sistema', motivoNota: 'Intento de envío reclamado.',
  });
  return { autorizado: true, id: fila.id };
}

// Fallback EXCLUSIVO de administración (nunca automático, nunca lo usa el
// Kit) para cuando el navegador del vendedor nunca llegó a completar el
// envío y nadie más puede reabrir esa sesión real. Sigue siendo la MISMA
// Forms API pública (nunca Objects API, nunca token, nunca un negocio) —
// arma los mismos campos aprobados, reconstruidos desde D1
// (`antecedentes_kit_json`, guardado por el propio Kit al cerrar la
// venta). `pageUri` se fija a la página real de producción del Kit — la
// causa confirmada del spam fue el dominio *.pages.dev, nunca que el
// envío viniera del servidor, así que un envío server-side con un pageUri
// de producción real es, hasta donde se confirmó, seguro (a validar en
// la prueba real de producción).
export async function enviarFormularioServerSide(db, requestId, ventaId) {
  const rows = await query(
    db, requestId,
    `SELECT v.producto, v.antecedentes_kit_json, v.nombre_proyecto,
            c.negocio, c.contacto_nombre, c.telefono, c.email AS cliente_email,
            u.nombre AS vendedor_nombre
     FROM ventas v JOIN clientes c ON c.id = v.cliente_id LEFT JOIN usuarios u ON u.email = v.vendedor_email
     WHERE v.id = ?`,
    [ventaId]
  );
  const venta = rows[0];
  if (!venta) return { ok: false, resumen: 'venta_no_encontrada' };

  let antecedentes = null;
  if (venta.antecedentes_kit_json) {
    try { antecedentes = JSON.parse(venta.antecedentes_kit_json); } catch (e) { antecedentes = null; }
  }
  const PRODUCTO_LABEL = {
    ficha: 'Ficha de Google', generico: 'Landing Express', personalizado: 'Landing Premium',
    ficha_generico: 'Ficha de Google + Landing Express', ficha_personalizado: 'Ficha de Google + Landing Premium',
    proyecto_personalizado: venta.nombre_proyecto || 'Proyecto personalizado',
  };
  const textoDesdeMapa = (mapa) => {
    if (!mapa || typeof mapa !== 'object') return null;
    const entradas = Object.entries(mapa).filter(([, v]) => v);
    return entradas.length ? entradas.map(([k, v]) => `${k}: ${v}`).join('\n') : null;
  };
  const nombreCompleto = (venta.contacto_nombre || '').trim();
  const partes = nombreCompleto ? nombreCompleto.split(' ') : [];

  const fields = [
    { objectTypeId: '0-1', name: 'company', value: venta.negocio || '—' },
    { objectTypeId: '0-1', name: 'producto_elegido', value: PRODUCTO_LABEL[venta.producto] || venta.producto },
    { objectTypeId: '0-1', name: 'ejecutivo_responsable', value: venta.vendedor_nombre || '—' },
  ];
  const respuestasLanding = textoDesdeMapa(antecedentes?.datosLanding);
  if (respuestasLanding) fields.push({ objectTypeId: '0-1', name: 'respuestas_landing', value: respuestasLanding });
  const respuestasFicha = textoDesdeMapa(antecedentes?.datosFicha);
  if (respuestasFicha) fields.push({ objectTypeId: '0-1', name: 'respuestas_ficha', value: respuestasFicha });
  if (partes[0]) fields.push({ objectTypeId: '0-1', name: 'firstname', value: partes[0] });
  if (partes.slice(1).join(' ')) fields.push({ objectTypeId: '0-1', name: 'lastname', value: partes.slice(1).join(' ') });
  if (venta.cliente_email) fields.push({ objectTypeId: '0-1', name: 'email', value: venta.cliente_email });
  if (venta.telefono) fields.push({ objectTypeId: '0-1', name: 'hs_whatsapp_phone_number', value: venta.telefono.replace(/[^\d+]/g, '') });

  try {
    const response = await fetch(HUBSPOT_FORMS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, context: { pageUri: PAGINA_KIT_PRODUCCION, pageName: 'Landing Page de Venta | Kit Comercial — RiO Impulso Digital' } }),
    });
    return response.ok ? { ok: true, resumen: 'ok' } : { ok: false, resumen: `http_${response.status}` };
  } catch (e) {
    return { ok: false, resumen: 'error_red' };
  }
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
