// Pruebas de functions/interno/api/health.js — RIO-110 sección 12 (API).
// Invoca el handler directamente con un `context` fabricado (la validación
// de Access ya se prueba de forma aislada en access.test.js — acá se asume
// que el middleware ya corrió y dejó `data.requestId`/`data.identity`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as healthHandler } from '../functions/interno/api/health.js';

function fakeContext({ method = 'GET', dbOk = true, dbBindingPresent = true } = {}) {
  const db = dbBindingPresent
    ? { prepare: () => ({ first: async () => (dbOk ? { ok: 1 } : (() => { throw new Error('D1 caído'); })()) }) }
    : undefined;
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/health', { method }),
    env: { DB: db },
    data: { requestId: 'req-health-test', identity: { email: 'ejecutivo@example.com' } },
  };
}

test('GET con D1 disponible — 200, status ok, sin datos sensibles', async () => {
  const response = await healthHandler(fakeContext({ method: 'GET', dbOk: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.status, 'ok');
  assert.deepEqual(body.data.checks, { pagesFunctions: true, access: true, d1Binding: true, d1Connectivity: true });
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /ejecutivo@example\.com/); // no debe filtrar el email del identity
  assert.doesNotMatch(raw, /token|jwt|secret/i);
});

test('GET sin binding de D1 — 503, degraded', async () => {
  const response = await healthHandler(fakeContext({ method: 'GET', dbBindingPresent: false }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.data.status, 'degraded');
  assert.equal(body.data.checks.d1Binding, false);
});

test('GET con D1 presente pero sin responder — 503, degraded', async () => {
  const response = await healthHandler(fakeContext({ method: 'GET', dbOk: false }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.data.checks.d1Connectivity, false);
});

test('método no permitido (POST) — 405', async () => {
  const response = await healthHandler(fakeContext({ method: 'POST' }));
  assert.equal(response.status, 405);
  const body = await response.json();
  assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
});
