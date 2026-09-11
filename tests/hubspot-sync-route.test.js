// Pruebas de GET /interno/api/hubspot-sync — RIO-120 (11/09/2026, alcance
// simplificado por Brenda: solo lectura, sin reintentar/descartar —
// "panel complejo de sincronización... descartado"). Exclusivo de
// administración.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as listHandler } from '../functions/interno/api/hubspot-sync/index.js';
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
  const state = { ventas: seed.ventas || [], clientes: seed.clientes || [], hubspot_sync: seed.hubspot_sync || [] };
  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => ({ success: true }),
    };
  }
  function runSelect(sql, p) {
    if (sql.includes('FROM hubspot_sync hs JOIN ventas v')) {
      let lista = state.hubspot_sync.filter((h) => h.canal === 'forms_api_browser');
      if (sql.includes("hs.estado = 'error'")) lista = lista.filter((h) => h.estado === 'error');
      return lista.map(enrich);
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function enrich(h) {
    const v = state.ventas.find((x) => x.id === h.venta_id);
    const c = v ? state.clientes.find((x) => x.id === v.cliente_id) : null;
    return { ...h, codigo_venta: v?.codigo_venta, venta_vendedor_email: v?.vendedor_email, venta_created_at: v?.created_at, negocio: c?.negocio };
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'GET', roleIdentity: ri, db, url } = {}) {
  return {
    request: new Request(url || 'https://rioimpulsodigital.com/interno/api/hubspot-sync', { method }),
    env: { DB: db },
    params: {},
    data: { requestId: 'req-hs-test', roleIdentity: ri },
  };
}

test('GET /hubspot-sync — un no-admin recibe 403', async () => {
  const db = fakeDb();
  const response = await listHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('GET /hubspot-sync — admin ve el listado, con datos de venta y cliente resueltos, sin acciones', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', codigo_venta: 'V-1', vendedor_email: 'ej@example.com', cliente_id: 'c1', created_at: '2026-09-11 10:00:00' }],
    clientes: [{ id: 'c1', negocio: 'Negocio Uno' }],
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'enviado', canal: 'forms_api_browser', intentos: 1, ultimo_intento_at: '2026-09-11 10:00:05', ultima_respuesta_resumen: 'ok', created_at: '2026-09-11 10:00:00', updated_at: '2026-09-11 10:00:05' }],
  });
  const response = await listHandler(fakeContext({ roleIdentity: admin(), db }));
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.sincronizaciones.length, 1);
  assert.equal(body.sincronizaciones[0].codigoVenta, 'V-1');
  assert.equal(body.sincronizaciones[0].clienteNegocio, 'Negocio Uno');
  assert.equal(body.sincronizaciones[0].estado, 'enviado');
  assert.equal(body.sincronizaciones[0].hubspotContactId, undefined, 'sin IDs de negocio/contacto — Objects API descartada');
});

test('GET /hubspot-sync — nunca incluye filas de mecanismos retirados (objects_api / forms_api_legacy)', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', codigo_venta: 'V-1', vendedor_email: 'ej@example.com', cliente_id: 'c1', created_at: '2026-09-11 10:00:00' }],
    clientes: [{ id: 'c1', negocio: 'Negocio Uno' }],
    hubspot_sync: [
      { id: 'h1', venta_id: 'v1', estado: 'legacy_form_accepted', canal: 'forms_api_legacy', intentos: 1 },
    ],
  });
  const response = await listHandler(fakeContext({ roleIdentity: admin(), db }));
  const body = (await response.json()).data;
  assert.equal(body.sincronizaciones.length, 0);
});

test('GET /hubspot-sync?conError=1 — filtra a estado "error"', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', codigo_venta: 'V-1', vendedor_email: 'ej@example.com', cliente_id: 'c1' }, { id: 'v2', codigo_venta: 'V-2', vendedor_email: 'ej@example.com', cliente_id: 'c1' }],
    clientes: [{ id: 'c1', negocio: 'x' }],
    hubspot_sync: [
      { id: 'h1', venta_id: 'v1', estado: 'enviado', canal: 'forms_api_browser', intentos: 1 },
      { id: 'h2', venta_id: 'v2', estado: 'error', canal: 'forms_api_browser', intentos: 1 },
    ],
  });
  const response = await listHandler(fakeContext({ roleIdentity: admin(), db, url: 'https://rioimpulsodigital.com/interno/api/hubspot-sync?conError=1' }));
  const body = (await response.json()).data;
  assert.equal(body.sincronizaciones.length, 1);
  assert.equal(body.sincronizaciones[0].estado, 'error');
});

test('método no permitido (DELETE) — 405', async () => {
  const db = fakeDb();
  const response = await listHandler(fakeContext({ method: 'DELETE', roleIdentity: admin(), db }));
  assert.equal(response.status, 405);
});
