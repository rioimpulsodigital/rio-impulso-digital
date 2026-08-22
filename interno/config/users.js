/*
 * Fuente única de identidad y mercado — Portal Interno RiO Impulso Digital.
 * Consumida por interno/index.html y interno/kit-venta-ficha-y-landing-page.html.
 * Arquitectura: RIO-91. Mapeo de ejecutivos confirmado por Brenda (RIO-91, sección 17).
 *
 * No duplicar este archivo ni su contenido en otras páginas del Portal.
 */

const USER_MAP = {
  'xikorivera@gmail.com':              { name: 'Pablo',     defaultMarket: 'CL', allowedMarkets: ['CL'] },
  'albertoperezmatta@gmail.com':       { name: 'Alberto',   defaultMarket: 'CL', allowedMarkets: ['CL'] },
  'gabrielaaleroa@gmail.com':          { name: 'Gabriela',  defaultMarket: 'CL', allowedMarkets: ['CL'] },
  'jotaherre024@gmail.com':            { name: 'Julia',     defaultMarket: 'CL', allowedMarkets: ['CL'] },
  'lorenaramirezfuentealba@gmail.com': { name: 'Lorena',    defaultMarket: 'CL', allowedMarkets: ['CL'] },
  'fjamis@gmail.com':                  { name: 'Fuad',      defaultMarket: 'CL', allowedMarkets: ['CL'] },
  'mchristian.reyes@gmail.com':        { name: 'Christian', defaultMarket: 'CL', allowedMarkets: ['CL'] },
  'brenda@rioimpulsodigital.com':      { name: 'Brenda',    defaultMarket: 'AR', allowedMarkets: ['CL', 'AR'] }
};

const MARKET_STORAGE_KEY = 'rio_portal_market';

function getCFUserEmail() {
  const cookie = document.cookie.split('; ').find(r => r.startsWith('CF_Authorization='));
  if (!cookie) return null;
  try {
    const payload = JSON.parse(atob(cookie.split('=')[1].split('.')[1]));
    return payload.email || null;
  } catch (e) {
    return null;
  }
}

// Devuelve { email, name, defaultMarket, allowedMarkets } o null si el correo
// autenticado no está registrado — null significa "bloqueado", nunca "Chile por defecto".
function resolveExecutive() {
  const email = getCFUserEmail();
  const entry = email ? USER_MAP[email] : null;
  return entry ? Object.assign({ email: email }, entry) : null;
}

// Resuelve el mercado activo para un ejecutivo ya identificado.
// - Un solo mercado autorizado → ese mercado siempre, localStorage se ignora por completo.
// - Más de un mercado autorizado (hoy, solo Brenda) → preferencia guardada si es válida,
//   si no existe o no pertenece a allowedMarkets, cae a defaultMarket. Nunca acepta un
//   valor de localStorage que no esté en allowedMarkets.
function resolveActiveMarket(executive) {
  if (!executive) return null;
  if (executive.allowedMarkets.length === 1) {
    return executive.allowedMarkets[0];
  }
  var stored = null;
  try {
    stored = window.localStorage.getItem(MARKET_STORAGE_KEY);
  } catch (e) {
    stored = null; // localStorage no disponible (modo privado, permisos, etc.)
  }
  if (stored && executive.allowedMarkets.indexOf(stored) !== -1) {
    return stored;
  }
  return executive.defaultMarket;
}

// Guarda la preferencia de mercado. Solo tiene efecto para ejecutivos multimercado
// y solo si el valor pertenece a sus allowedMarkets — nunca guarda un mercado no autorizado.
function setActiveMarket(executive, market) {
  if (!executive || executive.allowedMarkets.length <= 1) return;
  if (executive.allowedMarkets.indexOf(market) === -1) return;
  try {
    window.localStorage.setItem(MARKET_STORAGE_KEY, market);
  } catch (e) {
    // localStorage no disponible — la selección sigue funcionando en memoria durante la sesión
  }
}
