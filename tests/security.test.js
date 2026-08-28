// Pruebas de functions/_shared/security.js — RIO-110 sección 12 (API: método, CORS, tamaño).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders, isMethodAllowed, hasExpectedContentType, isBodyTooLarge, MAX_REQUEST_BODY_BYTES } from '../functions/_shared/security.js';

function req({ method = 'GET', origin, contentType, contentLength } = {}) {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  if (contentType) headers.set('Content-Type', contentType);
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  return new Request('https://rioimpulsodigital.com/interno/api/health', { method, headers });
}

test('CORS: origen de producción permitido', () => {
  const headers = corsHeaders(req({ origin: 'https://rioimpulsodigital.com' }));
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://rioimpulsodigital.com');
});

test('CORS: subdominio de vista previa permitido', () => {
  const headers = corsHeaders(req({ origin: 'https://abc123.rio-impulso-digital.pages.dev' }));
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://abc123.rio-impulso-digital.pages.dev');
});

test('CORS: origen ajeno rechazado (sin headers de CORS)', () => {
  const headers = corsHeaders(req({ origin: 'https://sitio-atacante.com' }));
  assert.deepEqual(headers, {});
});

test('CORS: sin Origin, sin headers de CORS', () => {
  const headers = corsHeaders(req({}));
  assert.deepEqual(headers, {});
});

test('método permitido cuando está en la lista', () => {
  assert.equal(isMethodAllowed(req({ method: 'GET' }), ['GET']), true);
});

test('método rechazado cuando no está en la lista', () => {
  assert.equal(isMethodAllowed(req({ method: 'DELETE' }), ['GET']), false);
});

test('Content-Type esperado no exigido en GET', () => {
  assert.equal(hasExpectedContentType(req({ method: 'GET' })), true);
});

test('Content-Type correcto en POST', () => {
  assert.equal(hasExpectedContentType(req({ method: 'POST', contentType: 'application/json' })), true);
});

test('Content-Type incorrecto en POST se rechaza', () => {
  assert.equal(hasExpectedContentType(req({ method: 'POST', contentType: 'text/plain' })), false);
});

test('body dentro del límite no se marca como demasiado grande', () => {
  assert.equal(isBodyTooLarge(req({ contentLength: MAX_REQUEST_BODY_BYTES - 1 })), false);
});

test('body por encima del límite se marca como demasiado grande', () => {
  assert.equal(isBodyTooLarge(req({ contentLength: MAX_REQUEST_BODY_BYTES + 1 })), true);
});

test('sin Content-Length no se asume demasiado grande', () => {
  assert.equal(isBodyTooLarge(req({})), false);
});
