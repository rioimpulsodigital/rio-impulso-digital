// Verifica que functions/_shared/access.js lee y compara correctamente el
// valor REAL de CF_ACCESS_AUD que Brenda guardó en .dev.vars (RIO-110,
// 28/08/2026) — sin necesitar una firma real de Cloudflare Access, que no se
// puede generar fuera de Cloudflare. Lo que este test prueba es la lectura
// del env var y la comparación exacta del `aud` (sin trim/casing/encoding
// accidentalmente laxo), usando un JWT firmado localmente con ese mismo
// valor real como audience.
//
// Se salta (no falla) si no existe .dev.vars o no tiene CF_ACCESS_AUD — así
// esta prueba no rompe en una máquina sin el secreto local cargado.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { verifyAccessRequest } from '../functions/_shared/access.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_VARS_PATH = resolve(__dirname, '..', '.dev.vars');
const TEAM_DOMAIN = 'rio-impulsodigital-team.cloudflareaccess.com'; // dato público, RIO-108

function readRealAud() {
  if (!existsSync(DEV_VARS_PATH)) return null;
  const content = readFileSync(DEV_VARS_PATH, 'utf8');
  const line = content.split('\n').find((l) => l.startsWith('CF_ACCESS_AUD='));
  if (!line) return null;
  const value = line.slice('CF_ACCESS_AUD='.length).trim();
  return value.length > 0 ? value : null;
}

const REAL_AUD = readRealAud();

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signToken(keyPair, kid, payloadOverrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    email: 'verificacion-rio-110@example.com',
    sub: 'test-real-aud',
    aud: [REAL_AUD],
    iss: `https://${TEAM_DOMAIN}`,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
    ...payloadOverrides,
  };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, signingInput);
  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

test('CF_ACCESS_AUD real (.dev.vars) — formato esperado (64 caracteres, sin espacios)', { skip: !REAL_AUD && 'no hay .dev.vars con CF_ACCESS_AUD en esta máquina' }, () => {
  assert.equal(typeof REAL_AUD, 'string');
  assert.equal(REAL_AUD.length, 64, 'la etiqueta AUD de Cloudflare Access es un hash de 64 caracteres');
  assert.match(REAL_AUD, /^[a-f0-9]{64}$/, 'debe ser hexadecimal en minúsculas, sin espacios ni comillas');
});

test('verifyAccessRequest() acepta un token firmado con el aud REAL de .dev.vars', { skip: !REAL_AUD && 'no hay .dev.vars con CF_ACCESS_AUD en esta máquina' }, async () => {
  const kid = 'kid-real-aud-test';
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    throw new Error('fetch inesperado en test: ' + url);
  };

  try {
    const token = await signToken(keyPair, kid);
    const request = new Request('https://rioimpulsodigital.com/interno/api/health', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: REAL_AUD };
    const identity = await verifyAccessRequest(request, ENV);
    assert.equal(identity.email, 'verificacion-rio-110@example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifyAccessRequest() rechaza un aud que difiere del real en un solo carácter (no hay match laxo/prefijo)', { skip: !REAL_AUD && 'no hay .dev.vars con CF_ACCESS_AUD en esta máquina' }, async () => {
  const kid = 'kid-real-aud-test-2';
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const almostRealAud = REAL_AUD.slice(0, -1) + (REAL_AUD.at(-1) === 'a' ? 'b' : 'a');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    throw new Error('fetch inesperado en test: ' + url);
  };

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const payload = {
      email: 'verificacion-rio-110@example.com',
      aud: [almostRealAud],
      iss: `https://${TEAM_DOMAIN}`,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
    };
    const encodedHeader = base64UrlEncodeJson(header);
    const encodedPayload = base64UrlEncodeJson(payload);
    const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, signingInput);
    const token = `${encodedHeader}.${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;

    const request = new Request('https://rioimpulsodigital.com/interno/api/health', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: REAL_AUD };
    await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
      assert.equal(e.reason, 'unexpected_audience');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
