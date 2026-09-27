// Pruebas de POST /interno/api/hubspot-sync/:ventaId — RIO-120 (corrección
// de confiabilidad, 11/09/2026). Fallback EXCLUSIVO de administración
// ({action:'reintentar'}) para cuando el navegador del vendedor nunca
// llegó a completar el envío. Usa el mismo mecanismo de reclamo/lease que
// el Kit — nunca fuerza un envío duplicado si hay un intento en curso.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as reintentarHandler } from '../functions/interno/api/hubspot-sync/[ventaId]/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'ejecutivo.a@example.com', nombre: 'Ejecutivo A', role: 'ejecutivo',
    allowedMarkets: ['CL'], defaultMarket: 'CL', userStatus: 'activo', canSell: true,
    permissions: PERMISSIONS.ejecutivo, ...overrides,
  };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb(seed = {}) {
  const state = {
    ventas: seed.ventas || [], clientes: seed.clientes || [], usuarios: seed.usuarios || [],
    hubspot_sync: seed.hubspot_sync || [], eventos_historial: [],
  };
  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => ({ success: true, meta: { changes: runMutation(sql, p) } }),
    };
  }
  function runSelect(sql, p) {
    if (sql.startsWith('SELECT id FROM ventas WHERE id')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      return v ? [{ id: v.id }] : [];
    }
    if (sql.startsWith('SELECT id, estado FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado }] : [];
    }
    if (sql.startsWith('SELECT id, estado, intentos FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado, intentos: fila.intentos }] : [];
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('LEFT JOIN usuarios u')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      if (!v) return [];
      const c = state.clientes.find((x) => x.id === v.cliente_id);
      return [{ producto: v.producto, antecedentes_kit_json: null, nombre_proyecto: null, negocio: c?.negocio || null, contacto_nombre: c?.contacto_nombre || null, telefono: c?.telefono || null, cliente_email: c?.email || null, vendedor_nombre: null }];
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith("UPDATE hubspot_sync SET estado = 'procesando'")) {
      const [ahora, updatedAt, ventaId, limiteLease] = p;
      const fila = state.hubspot_sync.find((h) => h.venta_id === ventaId);
      if (!fila) return 0;
      const elegible = ['pendiente', 'error'].includes(fila.estado) || (fila.estado === 'procesando' && fila.ultimo_intento_at <= limiteLease);
      if (!elegible) return 0;
      fila.estado = 'procesando'; fila.intentos = (fila.intentos || 0) + 1; fila.ultimo_intento_at = ahora; fila.updated_at = updatedAt;
      return 1;
    }
    if (sql.startsWith('INSERT INTO hubspot_sync') && sql.includes("'procesando', 'forms_api_browser'")) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: 'procesando', intentos: 1, ultimo_intento_at: p[2] });
      return 1;
    }
    if (sql.startsWith('UPDATE hubspot_sync SET estado')) {
      const fila = state.hubspot_sync.find((h) => h.id === p[5]);
      if (fila) Object.assign(fila, { estado: p[0], intentos: p[1], ultima_respuesta_resumen: p[3] || null });
      return fila ? 1 : 0;
    }
    if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0] });
      return 1;
    }
    throw new Error('mutación inesperada en test: ' + sql);
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'POST', body, roleIdentity: ri, db, params } = {}) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/hubspot-sync/v1', init),
    env: { DB: db },
    params: params || { ventaId: 'v1' },
    data: { requestId: 'req-hsv-test', roleIdentity: ri },
  };
}

const BASE_SEED = { ventas: [{ id: 'v1', cliente_id: 'c1', producto: 'ficha' }], clientes: [{ id: 'c1', negocio: 'Negocio QA', email: 'juan@qa.cl' }] };

test('un no-admin recibe 403', async () => {
  const db = fakeDb({ ...BASE_SEED, hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', intentos: 1 }] });
  const response = await reintentarHandler(fakeContext({ body: { action: 'reintentar' }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('admin reintenta sobre una fila en "error": reclama el intento y envía server-side (fallback, nunca Objects API)', async () => {
  const db = fakeDb({ ...BASE_SEED, hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', intentos: 1, ultimo_intento_at: '2026-09-11 00:00:00' }] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const response = await reintentarHandler(fakeContext({ body: { action: 'reintentar' }, roleIdentity: admin(), db }));
    assert.equal(response.status, 200);
    const body = (await response.json()).data;
    assert.equal(body.estado, 'enviado');
    assert.equal(db._state.hubspot_sync[0].estado, 'enviado');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin reintenta sobre una venta ya "enviado" — 409, nunca reenvía', async () => {
  const db = fakeDb({ ...BASE_SEED, hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'enviado', intentos: 1 }] });
  const response = await reintentarHandler(fakeContext({ body: { action: 'reintentar' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 409);
  const body = (await response.json()).error;
  assert.equal(body.code, 'SINCRONIZACION_NO_DISPONIBLE');
});

test('admin reintenta mientras hay un intento en curso (lease vigente) — 409, nunca duplica el envío', async () => {
  const db = fakeDb({ ...BASE_SEED, hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'procesando', intentos: 1, ultimo_intento_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }] });
  const response = await reintentarHandler(fakeContext({ body: { action: 'reintentar' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 409);
});

test('un error de HubSpot en el reintento deja la fila en "error", nunca lanza', async () => {
  const db = fakeDb({ ...BASE_SEED, hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', intentos: 1, ultimo_intento_at: '2026-09-11 00:00:00' }] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    const response = await reintentarHandler(fakeContext({ body: { action: 'reintentar' }, roleIdentity: admin(), db }));
    assert.equal(response.status, 200);
    const body = (await response.json()).data;
    assert.equal(body.estado, 'error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('venta inexistente devuelve 404', async () => {
  const db = fakeDb();
  const response = await reintentarHandler(fakeContext({ body: { action: 'reintentar' }, roleIdentity: admin(), db, params: { ventaId: 'no-existe' } }));
  assert.equal(response.status, 404);
});

test('action inválida se rechaza (solo "reintentar")', async () => {
  const db = fakeDb({ ...BASE_SEED, hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', intentos: 1 }] });
  const response = await reintentarHandler(fakeContext({ body: { action: 'descartar' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

test('método no permitido (GET) — 405', async () => {
  const db = fakeDb(BASE_SEED);
  const response = await reintentarHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db }));
  assert.equal(response.status, 405);
});
