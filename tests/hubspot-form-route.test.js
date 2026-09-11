// Pruebas de POST /interno/api/ventas/:id/hubspot-form — RIO-120
// (11/09/2026). El navegador (Kit) llama a esto después de intentar (o
// saltar deliberadamente en Preview) el envío del formulario a HubSpot —
// lo llama el vendedor dueño de la venta, o administración. Nunca un
// tercero, nunca bloquea nada de la venta en D1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as hubspotFormHandler } from '../functions/interno/api/ventas/[id]/hubspot-form.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'vendedor@example.com', nombre: 'Vendedor', role: 'ejecutivo',
    allowedMarkets: ['CL'], defaultMarket: 'CL', userStatus: 'activo', canSell: true,
    permissions: PERMISSIONS.ejecutivo, ...overrides,
  };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb(seed = {}) {
  const state = { ventas: seed.ventas || [], hubspot_sync: seed.hubspot_sync || [], eventos_historial: [] };
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
    if (sql.startsWith('SELECT id, vendedor_email FROM ventas WHERE id')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      return v ? [{ id: v.id, vendedor_email: v.vendedor_email }] : [];
    }
    if (sql.startsWith('SELECT id, estado, intentos FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado, intentos: fila.intentos }] : [];
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO hubspot_sync')) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: p[2], intentos: 1, ultima_respuesta_resumen: p[4] || null });
    } else if (sql.startsWith('UPDATE hubspot_sync SET estado')) {
      const fila = state.hubspot_sync.find((h) => h.id === p[5]);
      if (fila) Object.assign(fila, { estado: p[0], intentos: p[1], ultima_respuesta_resumen: p[3] || null });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'POST', body, roleIdentity: ri, db, params } = {}) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas/v1/hubspot-form', init),
    env: { DB: db },
    params: params || { id: 'v1' },
    data: { requestId: 'req-hf-test', roleIdentity: ri },
  };
}

const VENTA_BASE = { ventas: [{ id: 'v1', vendedor_email: 'vendedor@example.com' }] };

test('el vendedor dueño de la venta puede reportar el resultado', async () => {
  const db = fakeDb(VENTA_BASE);
  const response = await hubspotFormHandler(fakeContext({ body: { estado: 'enviado', resumen: 'ok' }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 200);
  assert.equal(db._state.hubspot_sync[0].estado, 'enviado');
});

test('administración también puede reportar el resultado (ej. en nombre del vendedor)', async () => {
  const db = fakeDb(VENTA_BASE);
  const response = await hubspotFormHandler(fakeContext({ body: { estado: 'error', resumen: 'http_500' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 200);
});

test('un ejecutivo AJENO a la venta recibe 403 — nunca puede reportar por una venta que no es suya', async () => {
  const db = fakeDb(VENTA_BASE);
  const otro = roleIdentity({ email: 'otro@example.com' });
  const response = await hubspotFormHandler(fakeContext({ body: { estado: 'enviado' }, roleIdentity: otro, db }));
  assert.equal(response.status, 403);
});

test('venta inexistente devuelve 404', async () => {
  const db = fakeDb();
  const response = await hubspotFormHandler(fakeContext({ body: { estado: 'enviado' }, roleIdentity: roleIdentity(), db, params: { id: 'no-existe' } }));
  assert.equal(response.status, 404);
});

test('un estado inválido se rechaza (solo "enviado" o "error")', async () => {
  const db = fakeDb(VENTA_BASE);
  const response = await hubspotFormHandler(fakeContext({ body: { estado: 'sincronizado' }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 400);
});

test('el resumen nunca se guarda crudo/sin límite — se recorta a 200 caracteres', async () => {
  const db = fakeDb(VENTA_BASE);
  const resumenLargo = 'x'.repeat(500);
  await hubspotFormHandler(fakeContext({ body: { estado: 'error', resumen: resumenLargo }, roleIdentity: roleIdentity(), db }));
  assert.equal(db._state.hubspot_sync[0].ultima_respuesta_resumen.length, 200);
});

test('método no permitido (GET) — 405', async () => {
  const db = fakeDb(VENTA_BASE);
  const response = await hubspotFormHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 405);
});
