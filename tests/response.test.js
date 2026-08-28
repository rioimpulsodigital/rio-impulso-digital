// Pruebas de functions/_shared/response.js — RIO-110 sección 12 (formato de API).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail, Errors, newRequestId } from '../functions/_shared/response.js';

test('ok() devuelve el formato uniforme con ok:true', async () => {
  const requestId = newRequestId();
  const response = ok({ hola: 'mundo' }, requestId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Request-Id'), requestId);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, { ok: true, data: { hola: 'mundo' }, error: null, requestId });
});

test('fail() devuelve el formato uniforme con ok:false y sin data', async () => {
  const requestId = newRequestId();
  const response = fail('ALGO_CODE', 'mensaje seguro', 418, requestId);
  assert.equal(response.status, 418);
  const body = await response.json();
  assert.deepEqual(body, { ok: false, data: null, error: { code: 'ALGO_CODE', message: 'mensaje seguro' }, requestId });
});

test('Errors.unauthenticated() usa status 401 y no filtra detalle interno', async () => {
  const requestId = newRequestId();
  const response = Errors.unauthenticated(requestId);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'UNAUTHENTICATED');
  assert.doesNotMatch(body.error.message, /token|jwt|sql|stack/i);
});

test('Errors.internal() nunca incluye stack trace', async () => {
  const requestId = newRequestId();
  const response = Errors.internal(requestId);
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(body), /at\s+\w+\s+\(.*:\d+:\d+\)/);
});

test('cada llamada de newRequestId() es única', () => {
  const a = newRequestId();
  const b = newRequestId();
  assert.notEqual(a, b);
});

test('respuestas incluyen headers de seguridad básicos', () => {
  const response = ok({}, newRequestId());
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
});
