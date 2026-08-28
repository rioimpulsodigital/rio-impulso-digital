// Controles básicos de seguridad transversales — RIO-110 sección 11.
// Denegación por defecto: todo lo que no está explícitamente permitido, se rechaza.

// Límite conservador para el cuerpo de una solicitud. Ninguna ruta de esta
// fundación acepta archivos — eso es RIO-116 (R2), fuera de alcance acá.
export const MAX_REQUEST_BODY_BYTES = 100 * 1024; // 100 KB

// Orígenes permitidos para CORS — solo el propio Portal, nunca "*".
// El sitio se sirve desde el mismo dominio que la API (Pages Functions sobre
// el mismo proyecto), así que en el uso normal el navegador ni siquiera
// necesita CORS — esto es una defensa en profundidad, no el mecanismo principal.
const ALLOWED_ORIGINS = new Set([
  'https://rioimpulsodigital.com',
  'https://www.rioimpulsodigital.com',
  'https://rio-impulso-digital.pages.dev',
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Vistas previas: <hash>.rio-impulso-digital.pages.dev — mismo proyecto,
  // ya protegidas aparte por Cloudflare Access (RIO-109).
  return /^https:\/\/[a-z0-9-]+\.rio-impulso-digital\.pages\.dev$/.test(origin);
}

export function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

// Verifica que el método de la solicitud esté en la lista explícita de la ruta.
export function isMethodAllowed(request, allowedMethods) {
  return allowedMethods.includes(request.method);
}

// Content-Type esperado en solicitudes con cuerpo (POST/PUT/PATCH).
export function hasExpectedContentType(request, expected = 'application/json') {
  const method = request.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const contentType = request.headers.get('Content-Type') || '';
  return contentType.toLowerCase().startsWith(expected);
}

// Rechaza cuerpos más grandes que MAX_REQUEST_BODY_BYTES usando el header
// Content-Length cuando está disponible. No es una garantía absoluta (un
// cliente podría omitir o mentir el header), pero descarta el caso común
// antes de leer el body completo en memoria.
export function isBodyTooLarge(request, limit = MAX_REQUEST_BODY_BYTES) {
  const len = request.headers.get('Content-Length');
  if (len === null) return false;
  const parsed = Number(len);
  return Number.isFinite(parsed) && parsed > limit;
}
