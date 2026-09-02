/*
 * Identidad y mercado — Portal Interno RiO Impulso Digital.
 *
 * RIO-111: la fuente de autoridad para usuarios, rol, mercados autorizados y
 * mercado predeterminado es D1 — este archivo ya NO contiene esa lista.
 * Antes tenía un USER_MAP hardcodeado que duplicaba exactamente lo que D1
 * ahora modela (riesgo #1 señalado desde RIO-97/RIO-108: dos listas que
 * podían desincronizarse — ya pasó una vez, ver RIO-124/125). Este archivo
 * consulta /interno/api/identidad/whoami (autenticado por Cloudflare
 * Access, resuelto server-side contra D1 — ver migrations/0003_identity.sql
 * y functions/_shared/authz.js) y expone el mismo contrato que ya usaban
 * interno/index.html, kit-venta-ficha-y-landing-page.html y
 * capacitacion-ficha-landing.html, para no reescribir esas páginas más de
 * lo necesario.
 *
 * Nada de este archivo decide si alguien está autorizado — solo pide esa
 * decisión al backend y expone el resultado. La autorización real de cada
 * endpoint de datos (cuando existan, RIO-112+) se valida de nuevo en el
 * servidor, igual que whoami — este archivo nunca es la fuente de verdad.
 */

const MARKET_STORAGE_PREFIX = 'rio_portal_market:';

// RIO-98: la clave de localStorage incluye el correo del ejecutivo — cada
// ejecutivo lee y guarda únicamente su propia preferencia, sin cambios en
// RIO-111 (esto es una comodidad de interfaz, no una decisión de acceso: el
// valor guardado siempre se valida contra allowedMarkets ya verificado por
// el servidor antes de usarse — ver resolveActiveMarket()).
function marketStorageKey(executive) {
  return MARKET_STORAGE_PREFIX + executive.email;
}

// Resuelve la identidad autenticada consultando el backend — nunca una
// lista local. Devuelve { email, name, defaultMarket, allowedMarkets } o
// null si el correo no está registrado, no tiene una asignación vigente, o
// está inactivo (401/403/404 del endpoint) — null sigue significando
// "bloqueado", nunca "Chile por defecto" (mismo criterio de RIO-91, ahora
// verificado en el servidor en vez de solo en el navegador).
async function resolveExecutive() {
  let response;
  try {
    response = await fetch('/interno/api/identidad/whoami', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    return null; // sin red o backend no disponible — bloqueado, no un mercado por defecto.
  }
  if (!response.ok) return null; // 401/403/404: sin sesión válida, no registrado, o inactivo.
  let body;
  try {
    body = await response.json();
  } catch (e) {
    return null;
  }
  if (!body || !body.ok || !body.data) return null;
  return {
    email: body.data.email,
    name: body.data.nombre,
    defaultMarket: body.data.defaultMarket,
    allowedMarkets: body.data.allowedMarkets,
    // RIO-118 (corrección — ventas administrativas y comisión de
    // supervisión, 02/09/2026): el Kit necesita saber si quien vende es
    // administración para mostrar el selector de tipo de venta — el
    // servidor vuelve a validar esto igual en POST /ventas, esto solo
    // decide qué mostrar en la interfaz.
    role: body.data.role,
    permissions: body.data.permissions,
  };
}

// Resuelve el mercado activo para un ejecutivo ya identificado.
// - Un solo mercado autorizado → ese mercado siempre, localStorage se ignora por completo.
// - Más de un mercado autorizado → preferencia guardada si es válida,
//   si no existe o no pertenece a allowedMarkets, cae a defaultMarket. Nunca acepta un
//   valor de localStorage que no esté en allowedMarkets (ambos ya verificados por el servidor).
function resolveActiveMarket(executive) {
  if (!executive) return null;
  if (executive.allowedMarkets.length === 1) {
    return executive.allowedMarkets[0];
  }
  var stored = null;
  try {
    stored = window.localStorage.getItem(marketStorageKey(executive));
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
    window.localStorage.setItem(marketStorageKey(executive), market);
  } catch (e) {
    // localStorage no disponible — la selección sigue funcionando en memoria durante la sesión
  }
}
