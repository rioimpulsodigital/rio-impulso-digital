// Sincronización con HubSpot — RIO-120 (11/09/2026), reemplaza el
// mecanismo temporal de Forms API construido en RIO-117.
//
// CAUSA CONFIRMADA de la incidencia que motivó este reemplazo (Brenda
// verificó directamente en HubSpot, 11/09/2026): los 2 envíos existentes
// de Preview (1/09 y 3/09) SÍ llegaron al formulario público, pero
// HubSpot los aisló como spam ("Dominio de sitio sin registrar" — origen
// *.pages.dev). Un `200 OK` de la Forms API NUNCA fue prueba real de que
// un contacto/negocio quedara creado — la Forms API no expone ninguna
// confirmación de objeto real. Por eso esta integración usa la Objects
// API (autenticada con un token privado), que sí devuelve el ID real del
// contacto y del negocio creados — esa es la única señal de éxito que se
// acepta acá.
//
// Esas 2 filas legacy de `hubspot_sync` NUNCA se tocan desde este
// archivo — quedan con estado 'legacy_form_accepted' (ver migración
// 0032), visibles solo para auditoría.
//
// Principio que atraviesa todo el archivo (igual que el resto del
// sistema): un error de HubSpot NUNCA revierte, bloquea ni oculta la
// venta ya guardada en D1 — la venta es del vendedor apenas se guarda,
// sin importar qué pase acá. D1 sigue siendo la única fuente de verdad
// operativa y financiera; HubSpot solo recibe lo que necesita para CRM y
// seguimiento comercial (nunca costos internos, comisiones, liquidaciones
// ni documentos bancarios).

import { query, execute } from './db.js';
import { logEvento } from './historial.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// Propiedades NUEVAS en el negocio (deal) — las únicas que RIO-120
// necesita crear en el portal (ver informe RIO-120, sección de permisos,
// para la lista exacta que debe crear Claudy). Todo lo demás reutiliza
// propiedades de contacto que el Kit ya usaba y que ya se auditaron
// funcionando (RIO-70/71/117).
const DEAL_PROP = {
  ventaId: 'rio_venta_id', // clave de idempotencia: nunca crea un segundo negocio para la misma venta.
  codigoVenta: 'rio_codigo_venta',
  mercado: 'rio_mercado',
  producto: 'rio_producto',
  vendedorEmail: 'rio_vendedor_email',
  estadoComercial: 'rio_estado_comercial',
  moneda: 'rio_moneda', // explícito: no depende de que el plan de HubSpot tenga multi-moneda configurada.
  origen: 'rio_origen',
};

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function normalizarWhatsapp(telefono) {
  return (telefono || '').replace(/[^\d+]/g, '') || null;
}

// Texto legible "Label: valor" a partir de un mapa estructurado — mismo
// formato que ya armaba el Kit en el navegador (buildLandingAnswersText/
// buildFichaAnswersText), reconstruido acá server-side desde
// ventas.antecedentes_kit_json (D1), nunca confiando en lo que el
// navegador diga que envió.
function textoDesdeMapa(mapa) {
  if (!mapa || typeof mapa !== 'object') return null;
  const entradas = Object.entries(mapa).filter(([, v]) => v);
  if (entradas.length === 0) return null;
  return entradas.map(([k, v]) => `${k}: ${v}`).join('\n');
}

async function sha256Hex(texto) {
  const bytes = new TextEncoder().encode(texto);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Construye los payloads de contacto y negocio EXCLUSIVAMENTE desde lo
// que ya está guardado en D1 (venta + cliente + antecedentesKit) — nunca
// desde un array de campos que mandara el navegador (así era el diseño
// v1/Forms API; acá D1 es la única fuente).
export async function construirPayloadHubSpot(db, requestId, ventaId, env) {
  const rows = await query(
    db, requestId,
    `SELECT v.id, v.codigo_venta, v.mercado, v.producto, v.moneda, v.precio_pactado, v.vendedor_email,
            v.estado_actual, v.antecedentes_kit_json, v.nombre_proyecto,
            c.negocio, c.contacto_nombre, c.telefono, c.email AS cliente_email,
            u.nombre AS vendedor_nombre,
            (SELECT p.estado_actual FROM proyectos p WHERE p.venta_id = v.id) AS proyecto_estado
     FROM ventas v JOIN clientes c ON c.id = v.cliente_id
     LEFT JOIN usuarios u ON u.email = v.vendedor_email
     WHERE v.id = ?`,
    [ventaId]
  );
  const venta = rows[0];
  if (!venta) return null;

  let antecedentes = null;
  if (venta.antecedentes_kit_json) {
    try { antecedentes = JSON.parse(venta.antecedentes_kit_json); } catch (e) { antecedentes = null; }
  }

  const PRODUCTO_LABEL = {
    ficha: 'Ficha de Google', generico: 'Landing Express', personalizado: 'Landing Premium',
    ficha_generico: 'Ficha de Google + Landing Express', ficha_personalizado: 'Ficha de Google + Landing Premium',
    proyecto_personalizado: venta.nombre_proyecto || 'Proyecto personalizado',
  };
  const productoLabel = PRODUCTO_LABEL[venta.producto] || venta.producto;

  const nombreCompleto = (venta.contacto_nombre || '').trim();
  const partesNombre = nombreCompleto ? nombreCompleto.split(' ') : [];
  const firstname = partesNombre[0] || null;
  const lastname = partesNombre.slice(1).join(' ') || null;

  const contactProperties = {};
  if (venta.cliente_email) contactProperties.email = venta.cliente_email;
  if (firstname) contactProperties.firstname = firstname;
  if (lastname) contactProperties.lastname = lastname;
  if (venta.negocio) contactProperties.company = venta.negocio;
  contactProperties.producto_elegido = productoLabel;
  if (venta.vendedor_nombre) contactProperties.ejecutivo_responsable = venta.vendedor_nombre;
  const whatsapp = normalizarWhatsapp(venta.telefono);
  if (whatsapp) contactProperties.hs_whatsapp_phone_number = whatsapp;
  if (antecedentes?.diagnosticoComercial?.notas) contactProperties.desafio = antecedentes.diagnosticoComercial.notas;
  const respuestasLanding = textoDesdeMapa(antecedentes?.datosLanding);
  if (respuestasLanding) contactProperties.respuestas_landing = respuestasLanding;
  const respuestasFicha = textoDesdeMapa(antecedentes?.datosFicha);
  if (respuestasFicha) contactProperties.respuestas_ficha = respuestasFicha;

  const dealProperties = {
    dealname: `${productoLabel} — ${venta.negocio || 'sin nombre'}`,
    amount: String(venta.precio_pactado),
    [DEAL_PROP.ventaId]: venta.id,
    [DEAL_PROP.codigoVenta]: venta.codigo_venta,
    [DEAL_PROP.mercado]: venta.mercado,
    [DEAL_PROP.producto]: venta.producto,
    [DEAL_PROP.vendedorEmail]: venta.vendedor_email,
    [DEAL_PROP.estadoComercial]: venta.estado_actual || 'registrado',
    [DEAL_PROP.moneda]: venta.moneda,
    [DEAL_PROP.origen]: 'Portal RiO',
  };
  // Pipeline/etapa son configurables por variable de entorno (nunca
  // hardcodeados — no se inventa un pipeline propio) — si no están
  // definidas, se omiten y HubSpot aplica el pipeline/etapa por defecto
  // del portal. Ver informe RIO-120 para el paso pendiente de Claudy.
  if (env?.HUBSPOT_DEAL_PIPELINE_ID) dealProperties.pipeline = env.HUBSPOT_DEAL_PIPELINE_ID;
  if (env?.HUBSPOT_DEAL_STAGE_ID) dealProperties.dealstage = env.HUBSPOT_DEAL_STAGE_ID;

  return { contactProperties, dealProperties, clienteEmail: venta.cliente_email || null };
}

class HubSpotApiError extends Error {
  constructor(resumen, status) {
    super(resumen);
    this.name = 'HubSpotApiError';
    this.resumen = resumen; // siempre seguro para mostrar — nunca la respuesta cruda.
    this.status = status;
  }
}

async function hsFetch(token, path, options) {
  const response = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options?.headers || {}) },
  });
  let body = null;
  try { body = await response.json(); } catch (e) { /* respuesta sin cuerpo JSON — no aplica a los endpoints usados acá */ }
  if (!response.ok) {
    // Nunca se propaga el cuerpo crudo (podría incluir detalles internos
    // de la cuenta de HubSpot) — solo status + categoría del error.
    throw new HubSpotApiError(`http_${response.status}`, response.status);
  }
  return body;
}

async function buscarContactoPorEmail(token, email) {
  const body = await hsFetch(token, '/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] }),
  });
  return body?.results?.[0]?.id || null;
}

async function buscarNegocioPorVentaId(token, ventaId) {
  const body = await hsFetch(token, '/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: DEAL_PROP.ventaId, operator: 'EQ', value: ventaId }] }] }),
  });
  return body?.results?.[0]?.id || null;
}

// Busca por email antes de crear — nunca crea un contacto duplicado. Si
// ya existe, ACTUALIZA solo los campos comerciales permitidos (los mismos
// que ya se envían) — nunca sobrescribe con blanco un campo que HubSpot
// ya tenía si acá viene vacío (solo se mandan las properties con valor).
async function buscarOActualizarContacto(token, { email, properties }) {
  if (!email) return { id: null, creado: false };
  const existenteId = await buscarContactoPorEmail(token, email);
  if (existenteId) {
    await hsFetch(token, `/crm/v3/objects/contacts/${existenteId}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
    return { id: existenteId, creado: false };
  }
  const creado = await hsFetch(token, '/crm/v3/objects/contacts', { method: 'POST', body: JSON.stringify({ properties }) });
  return { id: creado.id, creado: true };
}

// Busca por rio_venta_id antes de crear — esta es la garantía real de
// "un solo negocio por venta" (nunca depende de que HubSpot deduplique
// nada por su cuenta).
async function buscarOCrearNegocio(token, { ventaId, properties }) {
  const existenteId = await buscarNegocioPorVentaId(token, ventaId);
  if (existenteId) return { id: existenteId, creado: false };
  const creado = await hsFetch(token, '/crm/v3/objects/deals', { method: 'POST', body: JSON.stringify({ properties }) });
  return { id: creado.id, creado: true };
}

async function asociarContactoYNegocio(token, { contactId, dealId }) {
  await hsFetch(token, `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`, { method: 'PUT' });
}

async function registrarEstado(db, requestId, { ventaId, estado, canal, resumen, contactId, dealId, payloadHash, actorEmail, intentosActuales, motivoNota }) {
  const ahora = nowSql();
  const existentes = await query(db, requestId, 'SELECT id, intentos, estado FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  let id;
  if (existentes[0]) {
    id = existentes[0].id;
    await execute(
      db, requestId,
      `UPDATE hubspot_sync SET estado = ?, canal = ?, intentos = ?, ultimo_intento_at = ?, ultima_respuesta_resumen = ?,
         hubspot_contact_id = COALESCE(?, hubspot_contact_id), hubspot_deal_id = COALESCE(?, hubspot_deal_id),
         payload_hash = COALESCE(?, payload_hash), updated_at = ? WHERE id = ?`,
      [estado, canal, intentosActuales, ahora, resumen || null, contactId || null, dealId || null, payloadHash || null, ahora, id]
    );
    await logEvento(db, requestId, {
      ventaId, entidad: 'hubspot_sync', entidadId: id, estadoAnterior: existentes[0].estado, estadoNuevo: estado,
      usuarioEmail: actorEmail || 'sistema', motivoNota: motivoNota || resumen || null,
    });
  } else {
    id = crypto.randomUUID();
    await execute(
      db, requestId,
      `INSERT INTO hubspot_sync (id, venta_id, estado, canal, intentos, ultimo_intento_at, ultima_respuesta_resumen, hubspot_contact_id, hubspot_deal_id, payload_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ventaId, estado, canal, intentosActuales, ahora, resumen || null, contactId || null, dealId || null, payloadHash || null, ahora, ahora]
    );
    await logEvento(db, requestId, {
      ventaId, entidad: 'hubspot_sync', entidadId: id, estadoAnterior: null, estadoNuevo: estado,
      usuarioEmail: actorEmail || 'sistema', motivoNota: motivoNota || resumen || null,
    });
  }
  return id;
}

// Crea el registro DURABLE de sincronización 'pendiente' — se llama
// siempre que se registra una venta nueva (nunca opcional), ANTES de
// intentar nada contra HubSpot. Así, aunque el intento real falle o ni
// siquiera se llegue a ejecutar (ej. Worker reiniciado a mitad de
// camino), la venta queda con un rastro auditable de que la
// sincronización está pendiente — nunca silenciosamente ausente.
export async function crearRegistroPendiente(db, requestId, { ventaId, actorEmail }) {
  return registrarEstado(db, requestId, { ventaId, estado: 'pendiente', canal: 'objects_api', intentosActuales: 0, actorEmail, motivoNota: 'Venta registrada — sincronización con HubSpot pendiente.' });
}

// Intenta la sincronización real. Nunca lanza — cualquier error queda
// registrado como estado 'error' y la función retorna normalmente, para
// que quien la llame (la creación de la venta, o el reintento manual de
// administración) nunca se rompa por esto.
export async function sincronizarVentaConHubSpot(db, requestId, env, { ventaId, actorEmail }) {
  const token = env?.HUBSPOT_PRIVATE_APP_TOKEN;
  const existentes = await query(db, requestId, 'SELECT id, estado, intentos, canal FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  const fila = existentes[0];
  // Legacy y 'sincronizado' nunca se re-procesan automáticamente — solo
  // por una acción explícita de administración distinta a esta (ver
  // route de reintento, que sí permite reintentar un 'error').
  if (fila && (fila.canal === 'forms_api_legacy' || fila.estado === 'sincronizado')) {
    return { estado: fila.estado, resumen: 'sin_cambios' };
  }
  const intentosActuales = (fila?.intentos || 0) + 1;

  if (!token) {
    await registrarEstado(db, requestId, { ventaId, estado: 'error', canal: 'objects_api', resumen: 'token_ausente', intentosActuales, actorEmail });
    return { estado: 'error', resumen: 'token_ausente' };
  }

  const payload = await construirPayloadHubSpot(db, requestId, ventaId, env);
  if (!payload) {
    await registrarEstado(db, requestId, { ventaId, estado: 'error', canal: 'objects_api', resumen: 'venta_no_encontrada', intentosActuales, actorEmail });
    return { estado: 'error', resumen: 'venta_no_encontrada' };
  }
  if (!payload.clienteEmail) {
    await registrarEstado(db, requestId, { ventaId, estado: 'error', canal: 'objects_api', resumen: 'cliente_sin_email', intentosActuales, actorEmail });
    return { estado: 'error', resumen: 'cliente_sin_email' };
  }

  const payloadHash = await sha256Hex(JSON.stringify(payload));
  await registrarEstado(db, requestId, { ventaId, estado: 'procesando', canal: 'objects_api', intentosActuales, payloadHash, actorEmail });

  try {
    const contacto = await buscarOActualizarContacto(token, { email: payload.clienteEmail, properties: payload.contactProperties });
    const negocio = await buscarOCrearNegocio(token, { ventaId, properties: payload.dealProperties });
    if (negocio.creado) {
      await asociarContactoYNegocio(token, { contactId: contacto.id, dealId: negocio.id });
    }
    await registrarEstado(db, requestId, {
      ventaId, estado: 'sincronizado', canal: 'objects_api', resumen: 'ok', intentosActuales,
      contactId: contacto.id, dealId: negocio.id, payloadHash, actorEmail,
      motivoNota: `Contacto ${contacto.creado ? 'creado' : 'actualizado'}, negocio ${negocio.creado ? 'creado' : 'ya existente'}.`,
    });
    console.log(JSON.stringify({ requestId, scope: 'hubspot_sync', reason: 'sincronizado', ventaId, contactId: contacto.id, dealId: negocio.id }));
    return { estado: 'sincronizado', resumen: 'ok', contactId: contacto.id, dealId: negocio.id };
  } catch (e) {
    const resumen = e instanceof HubSpotApiError ? e.resumen : 'error_red';
    const status = e instanceof HubSpotApiError ? e.status : null;
    // 4xx (payload/credencial inválida) no se reintenta solo — requiere
    // corrección. 5xx/red sí es candidato a reintento (transitorio).
    const estadoFinal = status && status >= 400 && status < 500 ? 'error' : 'reintento_pendiente';
    const proximoReintento = estadoFinal === 'reintento_pendiente' ? new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) : null;
    await execute(db, requestId, 'UPDATE hubspot_sync SET proximo_reintento_at = ? WHERE venta_id = ?', [proximoReintento, ventaId]);
    await registrarEstado(db, requestId, { ventaId, estado: estadoFinal, canal: 'objects_api', resumen, intentosActuales, payloadHash, actorEmail });
    console.error(JSON.stringify({ requestId, scope: 'hubspot_sync', reason: 'sincronizacion_fallida', ventaId, resumen }));
    return { estado: estadoFinal, resumen };
  }
}

// Descarte administrativo explícito — la sincronización deja de
// reintentarse, con motivo y autor auditados. Nunca borra la fila ni el
// historial de intentos previos.
export async function descartarSincronizacion(db, requestId, { ventaId, motivo, actorEmail }) {
  const ahora = nowSql();
  const filas = await query(db, requestId, 'SELECT id, estado FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  if (!filas[0]) return null;
  await execute(
    db, requestId,
    "UPDATE hubspot_sync SET estado = 'descartado', motivo_descarte = ?, descartado_por = ?, descartado_at = ?, updated_at = ? WHERE id = ?",
    [motivo, actorEmail, ahora, ahora, filas[0].id]
  );
  await logEvento(db, requestId, {
    ventaId, entidad: 'hubspot_sync', entidadId: filas[0].id, estadoAnterior: filas[0].estado, estadoNuevo: 'descartado',
    usuarioEmail: actorEmail, motivoNota: motivo,
  });
  return filas[0].id;
}

export async function obtenerEstadoSincronizacion(db, requestId, ventaId) {
  const rows = await query(db, requestId, 'SELECT * FROM hubspot_sync WHERE venta_id = ?', [ventaId]);
  return rows[0] || null;
}

export async function listarSincronizaciones(db, requestId, { soloConError = false } = {}) {
  const sql = soloConError
    ? `SELECT hs.*, v.codigo_venta, v.vendedor_email AS venta_vendedor_email, v.created_at AS venta_created_at, c.negocio
       FROM hubspot_sync hs JOIN ventas v ON v.id = hs.venta_id JOIN clientes c ON c.id = v.cliente_id
       WHERE hs.estado IN ('error', 'reintento_pendiente') ORDER BY hs.updated_at DESC`
    : `SELECT hs.*, v.codigo_venta, v.vendedor_email AS venta_vendedor_email, v.created_at AS venta_created_at, c.negocio
       FROM hubspot_sync hs JOIN ventas v ON v.id = hs.venta_id JOIN clientes c ON c.id = v.cliente_id
       ORDER BY hs.updated_at DESC`;
  return query(db, requestId, sql, []);
}
