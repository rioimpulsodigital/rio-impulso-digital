// Pruebas de functions/_shared/hubspot.js — RIO-120 (11/09/2026),
// reemplaza la suite de RIO-117 (Forms API) por la integración real
// server-to-server (Objects API). Cubre el estado/máquina de
// sincronización a nivel unitario: idempotencia (nunca duplica la fila,
// nunca duplica el negocio), nunca lanza una excepción hacia quien la
// llama, distingue 4xx (error, no se reintenta solo) de 5xx/red
// (reintento_pendiente), preserva y nunca reprocesa las filas legacy de
// Forms API, y el descarte administrativo explícito.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crearRegistroPendiente, sincronizarVentaConHubSpot, descartarSincronizacion,
  obtenerEstadoSincronizacion, listarSincronizaciones,
} from '../functions/_shared/hubspot.js';

function fakeDb(seed = {}) {
  const state = {
    hubspot_sync: seed.hubspot_sync || [],
    eventos_historial: seed.eventos_historial || [],
    ventas: seed.ventas || [],
    clientes: seed.clientes || [],
    usuarios: seed.usuarios || [],
    proyectos: seed.proyectos || [],
  };
  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => { runMutation(sql, p); return { success: true }; },
    };
  }
  function runSelect(sql, p) {
    if (sql.startsWith('SELECT id, intentos, estado FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, intentos: fila.intentos, estado: fila.estado }] : [];
    }
    if (sql.startsWith('SELECT id, estado, intentos, canal FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado, intentos: fila.intentos, canal: fila.canal }] : [];
    }
    if (sql.startsWith('SELECT id, estado FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado }] : [];
    }
    if (sql.startsWith('SELECT * FROM hubspot_sync WHERE venta_id')) {
      return state.hubspot_sync.filter((h) => h.venta_id === p[0]);
    }
    if (sql.includes('FROM hubspot_sync hs JOIN ventas v') && sql.includes("estado IN ('error', 'reintento_pendiente')")) {
      return state.hubspot_sync
        .filter((h) => ['error', 'reintento_pendiente'].includes(h.estado))
        .map((h) => ({ ...h, codigo_venta: 'V-TEST', venta_vendedor_email: 'x@example.com', venta_created_at: '2026-09-11 00:00:00', negocio: 'Cliente test' }));
    }
    if (sql.includes('FROM hubspot_sync hs JOIN ventas v')) {
      return state.hubspot_sync
        .map((h) => ({ ...h, codigo_venta: 'V-TEST', venta_vendedor_email: 'x@example.com', venta_created_at: '2026-09-11 00:00:00', negocio: 'Cliente test' }));
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.id = ?')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      if (!v) return [];
      const c = state.clientes.find((x) => x.id === v.cliente_id);
      const u = state.usuarios.find((x) => x.email === v.vendedor_email);
      return [{
        id: v.id, codigo_venta: v.codigo_venta, mercado: v.mercado, producto: v.producto, moneda: v.moneda,
        precio_pactado: v.precio_pactado, vendedor_email: v.vendedor_email, estado_actual: v.estado_actual,
        antecedentes_kit_json: v.antecedentes_kit_json || null, nombre_proyecto: v.nombre_proyecto || null,
        negocio: c?.negocio || null, contacto_nombre: c?.contacto_nombre || null, telefono: c?.telefono || null,
        cliente_email: c?.email || null, vendedor_nombre: u?.nombre || null, proyecto_estado: null,
      }];
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO hubspot_sync')) {
      state.hubspot_sync.push({
        id: p[0], venta_id: p[1], estado: p[2], canal: p[3], intentos: p[4], ultimo_intento_at: p[5],
        ultima_respuesta_resumen: p[6] || null, hubspot_contact_id: p[7] || null, hubspot_deal_id: p[8] || null,
        payload_hash: p[9] || null, motivo_descarte: null, descartado_por: null, proximo_reintento_at: null,
        created_at: p[10], updated_at: p[11],
      });
    } else if (sql.startsWith("UPDATE hubspot_sync SET estado = 'descartado'")) {
      const fila = state.hubspot_sync.find((h) => h.id === p[4]);
      if (fila) Object.assign(fila, { estado: 'descartado', motivo_descarte: p[0], descartado_por: p[1], descartado_at: p[2], updated_at: p[3] });
    } else if (sql.startsWith('UPDATE hubspot_sync SET proximo_reintento_at')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[1]);
      if (fila) fila.proximo_reintento_at = p[0];
    } else if (sql.startsWith('UPDATE hubspot_sync SET estado')) {
      const fila = state.hubspot_sync.find((h) => h.id === p[9]);
      if (fila) {
        Object.assign(fila, {
          estado: p[0], canal: p[1], intentos: p[2], ultimo_intento_at: p[3], ultima_respuesta_resumen: p[4] || null,
          hubspot_contact_id: p[5] || fila.hubspot_contact_id, hubspot_deal_id: p[6] || fila.hubspot_deal_id,
          payload_hash: p[7] || fila.payload_hash, updated_at: p[8],
        });
      }
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function mockFetchSecuencia(respuestas) {
  let i = 0;
  return async () => {
    const r = respuestas[Math.min(i, respuestas.length - 1)];
    i++;
    return { ok: r.status < 400, status: r.status, json: async () => r.body || {} };
  };
}

test('sincronizarVentaConHubSpot() — sin token, queda en error/token_ausente y nunca llama a fetch', async () => {
  const db = fakeDb({ ventas: [{ id: 'v1', cliente_id: 'c1' }], clientes: [{ id: 'c1', negocio: 'x', email: 'a@x.com' }] });
  let llamado = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { llamado = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const resultado = await sincronizarVentaConHubSpot(db, 'req-1', {}, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(resultado.estado, 'error');
    assert.equal(resultado.resumen, 'token_ausente');
    assert.equal(llamado, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sincronizarVentaConHubSpot() — un reintento tras un fallo actualiza la MISMA fila (nunca crea una segunda), y suma intentos', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', cliente_id: 'c1', codigo_venta: 'V-1', mercado: 'CL', producto: 'ficha', moneda: 'CLP', precio_pactado: 50000, vendedor_email: 'v@example.com', estado_actual: 'registrado' }],
    clientes: [{ id: 'c1', negocio: 'Negocio X', email: 'cliente@x.com' }],
  });
  await crearRegistroPendiente(db, 'req-0', { ventaId: 'v1', actorEmail: 'admin@example.com' });
  const env = { HUBSPOT_PRIVATE_APP_TOKEN: 'token-1' };
  const originalFetch = globalThis.fetch;
  // Primer intento: falla la búsqueda/creación de contacto (500). Segundo: todo exitoso.
  let intento = 0;
  globalThis.fetch = async (url, options) => {
    const path = String(url).replace('https://api.hubapi.com', '');
    if (intento === 0 && path === '/crm/v3/objects/contacts/search') { intento++; return { ok: false, status: 500, json: async () => ({}) }; }
    if (path.endsWith('/search')) return { ok: true, status: 200, json: async () => ({ results: [] }) };
    if (path === '/crm/v3/objects/contacts' && options.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'contact-1' }) };
    if (path === '/crm/v3/objects/deals' && options.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'deal-1' }) };
    if (path.includes('/associations/')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('inesperado: ' + path);
  };
  try {
    const primero = await sincronizarVentaConHubSpot(db, 'req-1', env, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(primero.estado, 'reintento_pendiente');
    assert.equal(db._state.hubspot_sync.length, 1, 'sigue habiendo una sola fila — nunca duplica el registro');
    assert.equal(db._state.hubspot_sync[0].intentos, 1, 'primer intento real de sincronización (crearRegistroPendiente no cuenta como intento)');

    const reintento = await sincronizarVentaConHubSpot(db, 'req-2', env, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(reintento.estado, 'sincronizado');
    assert.equal(db._state.hubspot_sync.length, 1);
    assert.equal(db._state.hubspot_sync[0].intentos, 2);
    assert.equal(db._state.hubspot_sync[0].hubspot_contact_id, 'contact-1');
    assert.equal(db._state.hubspot_sync[0].hubspot_deal_id, 'deal-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sincronizarVentaConHubSpot() — nunca lanza una excepción hacia el llamador ni ante un error de red', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', cliente_id: 'c1', codigo_venta: 'V-1', mercado: 'CL', producto: 'ficha', moneda: 'CLP', precio_pactado: 50000, vendedor_email: 'v@example.com', estado_actual: 'registrado' }],
    clientes: [{ id: 'c1', negocio: 'Negocio X', email: 'cliente@x.com' }],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const resultado = await sincronizarVentaConHubSpot(db, 'req-1', { HUBSPOT_PRIVATE_APP_TOKEN: 't' }, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(resultado.estado, 'reintento_pendiente', 'un error de red es transitorio, no definitivo');
    assert.equal(resultado.resumen, 'error_red');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sincronizarVentaConHubSpot() — un 4xx queda en "error", nunca en "reintento_pendiente" (no se reintenta solo)', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', cliente_id: 'c1', codigo_venta: 'V-1', mercado: 'CL', producto: 'ficha', moneda: 'CLP', precio_pactado: 50000, vendedor_email: 'v@example.com', estado_actual: 'registrado' }],
    clientes: [{ id: 'c1', negocio: 'Negocio X', email: 'cliente@x.com' }],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSecuencia([{ status: 401 }]);
  try {
    const resultado = await sincronizarVentaConHubSpot(db, 'req-1', { HUBSPOT_PRIVATE_APP_TOKEN: 't' }, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(resultado.estado, 'error');
    assert.equal(resultado.resumen, 'http_401');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sincronizarVentaConHubSpot() — una venta sin email de cliente queda en error, sin intentar fetch', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', cliente_id: 'c1', codigo_venta: 'V-1', mercado: 'CL', producto: 'ficha', moneda: 'CLP', precio_pactado: 50000, vendedor_email: 'v@example.com', estado_actual: 'registrado' }],
    clientes: [{ id: 'c1', negocio: 'Negocio X', email: null }],
  });
  let llamado = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { llamado = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const resultado = await sincronizarVentaConHubSpot(db, 'req-1', { HUBSPOT_PRIVATE_APP_TOKEN: 't' }, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(resultado.estado, 'error');
    assert.equal(resultado.resumen, 'cliente_sin_email');
    assert.equal(llamado, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sincronizarVentaConHubSpot() — una fila legacy (Forms API) nunca se reprocesa automáticamente', async () => {
  const db = fakeDb({
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'legacy_form_accepted', canal: 'forms_api_legacy', intentos: 1 }],
  });
  let llamado = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { llamado = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const resultado = await sincronizarVentaConHubSpot(db, 'req-1', { HUBSPOT_PRIVATE_APP_TOKEN: 't' }, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(resultado.estado, 'legacy_form_accepted');
    assert.equal(llamado, false, 'nunca se reenvía una venta legacy automáticamente');
    assert.equal(db._state.hubspot_sync[0].estado, 'legacy_form_accepted', 'la fila legacy nunca se sobrescribe');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sincronizarVentaConHubSpot() — una venta ya "sincronizado" nunca se vuelve a procesar automáticamente', async () => {
  const db = fakeDb({
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'sincronizado', canal: 'objects_api', intentos: 1, hubspot_contact_id: 'contact-1', hubspot_deal_id: 'deal-1' }],
  });
  let llamado = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { llamado = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const resultado = await sincronizarVentaConHubSpot(db, 'req-1', { HUBSPOT_PRIVATE_APP_TOKEN: 't' }, { ventaId: 'v1', actorEmail: 'admin@example.com' });
    assert.equal(resultado.estado, 'sincronizado');
    assert.equal(llamado, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('descartarSincronizacion() — exige motivo, queda auditado con autor y fecha, nunca borra la fila', async () => {
  const db = fakeDb({ hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', canal: 'objects_api', intentos: 3 }] });
  const id = await descartarSincronizacion(db, 'req-1', { ventaId: 'v1', motivo: 'Cliente canceló antes de sincronizar', actorEmail: 'admin@example.com' });
  assert.equal(id, 'h1');
  assert.equal(db._state.hubspot_sync[0].estado, 'descartado');
  assert.equal(db._state.hubspot_sync[0].motivo_descarte, 'Cliente canceló antes de sincronizar');
  assert.equal(db._state.hubspot_sync[0].descartado_por, 'admin@example.com');
  assert.ok(db._state.eventos_historial.some((e) => e.entidad === 'hubspot_sync' && e.estado_nuevo === 'descartado'));
});

test('obtenerEstadoSincronizacion() — devuelve null si nunca se intentó sincronizar esta venta', async () => {
  const db = fakeDb();
  const estado = await obtenerEstadoSincronizacion(db, 'req-1', 'venta-sin-intentos');
  assert.equal(estado, null);
});

test('listarSincronizaciones() — con soloConError filtra a error/reintento_pendiente, nunca sincronizado/legacy', async () => {
  const db = fakeDb({
    hubspot_sync: [
      { id: 'h1', venta_id: 'v1', estado: 'sincronizado', canal: 'objects_api', intentos: 1 },
      { id: 'h2', venta_id: 'v2', estado: 'error', canal: 'objects_api', intentos: 2 },
      { id: 'h3', venta_id: 'v3', estado: 'reintento_pendiente', canal: 'objects_api', intentos: 1 },
      { id: 'h4', venta_id: 'v4', estado: 'legacy_form_accepted', canal: 'forms_api_legacy', intentos: 1 },
    ],
  });
  const resultado = await listarSincronizaciones(db, 'req-1', { soloConError: true });
  assert.equal(resultado.length, 2);
  assert.ok(resultado.every((r) => ['error', 'reintento_pendiente'].includes(r.estado)));
});
