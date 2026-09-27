// Validación server-side del JWT de Cloudflare Access — RIO-110 sección 8.
//
// La protección perimetral de Access (ya vigente desde RIO-91) impide que una
// solicitud sin sesión válida llegue siquiera hasta acá, pero eso NO es
// autorización de backend: cualquier código que confíe en el header sin
// verificar firma/aud/emisor/vigencia repite exactamente el mismo problema que
// ya tiene `users.js` en el navegador (`atob()` sin verificar firma — ver
// RIO-97 sección 1). Esta capa es la que cierra esa brecha para el backend.
//
// No usa ninguna librería de JWT: la Web Crypto API estándar del runtime de
// Workers/Pages Functions alcanza para verificar RS256 sin dependencias.

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora — mismo criterio recomendado por Cloudflare para cachear certs.
let jwksCache = null; // { keys: Map<kid, CryptoKey>, fetchedAt: number, teamDomain: string }

export class AccessValidationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'AccessValidationError';
    this.reason = reason; // código corto interno — nunca se expone tal cual al cliente.
  }
}

function base64UrlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(part) {
  const bytes = base64UrlToUint8Array(part);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Extrae el JWT de Access de la solicitud. Cloudflare lo entrega en el header
// `Cf-Access-Jwt-Assertion` en las solicitudes que ya pasaron por Access; como
// respaldo también se acepta la cookie `CF_Authorization` (mismo valor, usada
// hoy por `users.js` en el navegador — ver RIO-91).
function extractToken(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}

async function fetchJwks(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  let response;
  try {
    response = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  } catch (e) {
    throw new AccessValidationError('jwks_fetch_network_error');
  }
  if (!response.ok) {
    throw new AccessValidationError('jwks_fetch_http_error');
  }
  let body;
  try {
    body = await response.json();
  } catch (e) {
    throw new AccessValidationError('jwks_invalid_json');
  }
  const keys = Array.isArray(body.keys) ? body.keys : (Array.isArray(body.public_certs) ? body.public_certs : null);
  if (!keys) throw new AccessValidationError('jwks_missing_keys');
  return keys;
}

async function getSigningKey(teamDomain, kid) {
  const now = Date.now();
  if (!jwksCache || jwksCache.teamDomain !== teamDomain || now - jwksCache.fetchedAt > JWKS_CACHE_TTL_MS) {
    const rawKeys = await fetchJwks(teamDomain);
    const keys = new Map();
    for (const jwk of rawKeys) {
      const keyId = jwk.kid;
      if (!keyId) continue;
      try {
        const cryptoKey = await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );
        keys.set(keyId, cryptoKey);
      } catch (e) {
        // Clave individual no importable (formato inesperado) — se ignora esa
        // clave puntual, no se aborta la carga de todo el JWKS por eso.
      }
    }
    jwksCache = { keys, fetchedAt: now, teamDomain };
  }
  const key = jwksCache.keys.get(kid);
  if (!key) {
    // Puede ser rotación de claves reciente — se fuerza un refresh una vez
    // antes de rendirse, en vez de rechazar de inmediato una clave legítima nueva.
    const rawKeys = await fetchJwks(teamDomain);
    const stillMissing = !rawKeys.some((k) => k.kid === kid);
    if (stillMissing) throw new AccessValidationError('signing_key_not_found');
    jwksCache = null;
    return getSigningKey(teamDomain, kid);
  }
  return key;
}

// Verifica el JWT de Access de una solicitud entrante.
// env debe traer CF_ACCESS_TEAM_DOMAIN y CF_ACCESS_AUD (ver wrangler config, sección 4).
// Devuelve { email, sub, payload } si es válido.
// Lanza AccessValidationError con una razón interna corta si no lo es —
// nunca debe filtrarse esa razón textual al cliente (ver response.js: siempre
// se traduce a un mensaje genérico de UNAUTHENTICATED).
export async function verifyAccessRequest(request, env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = env.CF_ACCESS_AUD;
  if (!teamDomain || !expectedAud) {
    // Falta de configuración del propio backend — no es un problema del
    // cliente, pero el resultado para quien llama debe ser el mismo rechazo
    // controlado (ver Errors.unauthenticated) sin detalle de infraestructura.
    throw new AccessValidationError('missing_server_configuration');
  }

  const token = extractToken(request);
  if (!token) throw new AccessValidationError('token_absent');

  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessValidationError('token_malformed');
  const [headerPart, payloadPart, signaturePart] = parts;

  let header, payload;
  try {
    header = base64UrlDecodeJson(headerPart);
    payload = base64UrlDecodeJson(payloadPart);
  } catch (e) {
    throw new AccessValidationError('token_malformed');
  }

  if (header.alg !== 'RS256') throw new AccessValidationError('unexpected_algorithm');
  if (!header.kid) throw new AccessValidationError('token_malformed');

  let signingKey;
  try {
    signingKey = await getSigningKey(teamDomain, header.kid);
  } catch (e) {
    if (e instanceof AccessValidationError) throw e;
    throw new AccessValidationError('jwks_unavailable');
  }

  const signedData = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let signatureBytes;
  try {
    signatureBytes = base64UrlToUint8Array(signaturePart);
  } catch (e) {
    throw new AccessValidationError('token_malformed');
  }

  const validSignature = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    signatureBytes,
    signedData
  );
  if (!validSignature) throw new AccessValidationError('invalid_signature');

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new AccessValidationError('token_expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) {
    throw new AccessValidationError('token_not_yet_valid');
  }

  const expectedIssuer = `https://${teamDomain}`;
  if (payload.iss !== expectedIssuer && payload.iss !== `${expectedIssuer}/`) {
    throw new AccessValidationError('unexpected_issuer');
  }

  const audClaim = payload.aud;
  const audList = Array.isArray(audClaim) ? audClaim : [audClaim];
  if (!audList.includes(expectedAud)) {
    throw new AccessValidationError('unexpected_audience');
  }

  if (!payload.email) throw new AccessValidationError('token_missing_email');

  return { email: payload.email, sub: payload.sub || null, payload };
}
