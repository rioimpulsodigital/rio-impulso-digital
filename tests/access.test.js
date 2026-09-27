// Pruebas de functions/_shared/access.js — RIO-110 sección 12 (Cloudflare Access).
// Corren con el runner nativo de Node (`npm test`), sin ningún servicio real
// de Cloudflare: se genera un par de claves RSA local y se simula el
// endpoint /cdn-cgi/access/certs interceptando `fetch`.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessRequest, AccessValidationError } from '../functions/_shared/access.js';

const TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
const AUD = 'test-aud-1234567890';
const KID = 'test-key-1';

let keyPair;
let publicJwk;
let originalFetch;

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signToken(payloadOverrides = {}, { kid = KID, alg = 'RS256' } = {}) {
  const header = { alg, typ: 'JWT', kid };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    email: 'ejecutivo@example.com',
    sub: 'user-123',
    aud: [AUD],
    iss: `https://${TEAM_DOMAIN}`,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
    ...payloadOverrides,
  };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, signingInput);
  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

function requestWithToken(token, { asCookie = false } = {}) {
  const headers = new Headers();
  if (token !== null) {
    if (asCookie) headers.set('Cookie', `CF_Authorization=${token}`);
    else headers.set('Cf-Access-Jwt-Assertion', token);
  }
  return new Request('https://rioimpulsodigital.com/interno/api/health', { headers });
}

const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD };

before(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    throw new Error('fetch inesperado en test: ' + url);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('token válido — devuelve la identidad', async () => {
  const token = await signToken();
  const request = requestWithToken(token);
  const identity = await verifyAccessRequest(request, ENV);
  assert.equal(identity.email, 'ejecutivo@example.com');
  assert.equal(identity.sub, 'user-123');
});

test('token válido vía cookie CF_Authorization (respaldo)', async () => {
  const token = await signToken();
  const request = requestWithToken(token, { asCookie: true });
  const identity = await verifyAccessRequest(request, ENV);
  assert.equal(identity.email, 'ejecutivo@example.com');
});

test('token ausente — rechaza', async () => {
  const request = requestWithToken(null);
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.ok(e instanceof AccessValidationError);
    assert.equal(e.reason, 'token_absent');
    return true;
  });
});

test('token malformado (no tiene 3 partes) — rechaza', async () => {
  const request = requestWithToken('esto-no-es-un-jwt');
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.equal(e.reason, 'token_malformed');
    return true;
  });
});

test('firma inválida (token alterado) — rechaza', async () => {
  const token = await signToken();
  const tampered = token.slice(0, -4) + 'abcd';
  const request = requestWithToken(tampered);
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.equal(e.reason, 'invalid_signature');
    return true;
  });
});

test('aud incorrecto — rechaza', async () => {
  const token = await signToken({ aud: ['otra-app-distinta'] });
  const request = requestWithToken(token);
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.equal(e.reason, 'unexpected_audience');
    return true;
  });
});

test('emisor incorrecto — rechaza', async () => {
  const token = await signToken({ iss: 'https://otro-team.cloudflareaccess.com' });
  const request = requestWithToken(token);
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.equal(e.reason, 'unexpected_issuer');
    return true;
  });
});

test('token vencido — rechaza', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await signToken({ exp: nowSeconds - 60 });
  const request = requestWithToken(token);
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.equal(e.reason, 'token_expired');
    return true;
  });
});

test('kid desconocido tras refresco de JWKS — rechaza', async () => {
  const token = await signToken({}, { kid: 'kid-que-no-existe' });
  const request = requestWithToken(token);
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.equal(e.reason, 'signing_key_not_found');
    return true;
  });
});

test('JWKS inaccesible (Access caído) — falla de forma controlada, no expone detalle', async () => {
  // kid nunca antes visto: fuerza un cache-miss real en getSigningKey() en vez
  // de reutilizar el JWKS ya cacheado por pruebas anteriores de este archivo.
  globalThis.fetch = async () => new Response('error', { status: 503 });
  const token = await signToken({}, { kid: 'kid-nunca-cacheado-access-caido' });
  const request = requestWithToken(token);
  await assert.rejects(() => verifyAccessRequest(request, ENV), (e) => {
    assert.ok(e instanceof AccessValidationError);
    return true;
  });
});

test('sin CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD configurados — rechaza sin intentar validar', async () => {
  const token = await signToken();
  const request = requestWithToken(token);
  await assert.rejects(() => verifyAccessRequest(request, {}), (e) => {
    assert.equal(e.reason, 'missing_server_configuration');
    return true;
  });
});
