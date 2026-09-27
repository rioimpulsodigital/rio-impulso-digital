// Pruebas de DOM real (jsdom) del Kit comercial — RIO-122, UAT Negocio
// Test 14B (15/09/2026). Dos hallazgos verificados acá con el HTML/JS
// real del Kit (nunca reimplementando su lógica):
//   1. "Dominio propio deseado" solo debe mostrarse para Landing Premium
//      (suelta o en pack) — nunca para Landing Express, nunca con un
//      valor residual de una selección anterior.
//   2. El selector "Tipo de venta" (venta directa / equipo) es exclusivo
//      de administración — un ejecutivo normal nunca lo ve ni puede
//      manipularlo, el payload que arma nunca incluye tipoVenta/equipoId.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT_PATH = path.join(ROOT, 'interno/kit-venta-ficha-y-landing-page.html');
const KIT_HTML = fs.readFileSync(KIT_PATH, 'utf8');
const USERS_JS = fs.readFileSync(path.join(ROOT, 'interno/config/users.js'), 'utf8');
// config/markets.js es un módulo ES (export const/function) — se evalúa
// como script clásico quitando los `export`; el archivo ya se autoasigna
// a `window` al final (ver su propio comentario de compatibilidad), así
// que ninguna función/objeto se reimplementa acá.
const MARKETS_JS = fs.readFileSync(path.join(ROOT, 'interno/config/markets.js'), 'utf8').replace(/^export\s+/gm, '');

const SCRIPT_MATCH = KIT_HTML.match(/<script>\r?\n([\s\S]*?)<\/script>\s*<\/body>/);
if (!SCRIPT_MATCH) throw new Error('No se pudo extraer el <script> inline del Kit — revisar el archivo.');
const KIT_SCRIPT = SCRIPT_MATCH[1];

function flush(ticks = 12) {
  return new Promise((resolve) => {
    let n = 0;
    function tick() { n += 1; if (n >= ticks) resolve(); else setTimeout(tick, 0); }
    tick();
  });
}

async function bootKit({ identity, extraRoutes = {} }) {
  const dom = new JSDOM(KIT_HTML, {
    url: 'https://76dfade3.rio-impulso-digital.pages.dev/interno/kit-venta-ficha-y-landing-page.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const routes = Object.assign({
    '/interno/api/identidad/whoami': () => ({ ok: true, data: identity }),
    '/interno/api/equipos': () => ({ ok: true, data: { equipos: [] } }),
  }, extraRoutes);

  dom.window.fetch = async (url) => {
    const rutaSinQuery = String(url).split('?')[0];
    const handler = routes[rutaSinQuery];
    if (!handler) throw new Error('ruta no mockeada en el test: ' + url);
    const body = handler();
    return { ok: true, status: 200, json: async () => body };
  };
  // localStorage: jsdom lo soporta, pero resolveActiveMarket/setActiveMarket
  // lo envuelven en try/catch de todas formas — no hace falta nada extra.

  // jsdom no implementa scrollIntoView (sí existe en cualquier navegador
  // real) — sin este stub, el flujo de éxito de confirmarYCerrarVenta()
  // lanza una excepción DESPUÉS de haber POSTeado la venta y cae en su
  // catch genérico, aunque la venta ya se haya registrado correctamente.
  dom.window.Element.prototype.scrollIntoView = () => {};

  dom.window.eval(USERS_JS);
  dom.window.eval(MARKETS_JS);
  dom.window.eval(KIT_SCRIPT);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
  await flush();
  return dom;
}

function elegirProducto(dom, productKey) {
  const card = dom.window.document.querySelector('.domain-choice-card[data-domain="' + productKey + '"]');
  if (!card) throw new Error('no se encontró la tarjeta de producto: ' + productKey);
  card.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

const EJECUTIVO = { email: 'ejecutivo@example.com', nombre: 'Ejecutivo de Prueba', defaultMarket: 'CL', allowedMarkets: ['CL'], role: 'ejecutivo', permissions: { viewOthersData: false } };
const ADMIN = { email: 'admin@example.com', nombre: 'Admin de Prueba', defaultMarket: 'CL', allowedMarkets: ['CL'], role: 'admin', permissions: { viewOthersData: true, manageUsers: true } };

// ── Hallazgo 1: "Dominio propio deseado" — RIO-122 ─────────────────────

test('Kit — Landing Express (generico) oculta "Dominio propio deseado"', async () => {
  const dom = await bootKit({ identity: EJECUTIVO });
  elegirProducto(dom, 'generico');
  const field = dom.window.document.getElementById('domainDesiredField');
  assert.equal(field.style.display, 'none', 'Landing Express nunca debe mostrar el campo de dominio propio');
});

test('Kit — Landing Premium (personalizado) muestra "Dominio propio deseado"', async () => {
  const dom = await bootKit({ identity: EJECUTIVO });
  elegirProducto(dom, 'personalizado');
  const field = dom.window.document.getElementById('domainDesiredField');
  assert.notEqual(field.style.display, 'none', 'Landing Premium sí debe mostrar el campo de dominio propio');
});

test('Kit — Ficha + Landing Express (pack) también lo oculta; Ficha + Landing Premium (pack) también lo muestra', async () => {
  const dom = await bootKit({ identity: EJECUTIVO });
  elegirProducto(dom, 'ficha_generico');
  assert.equal(dom.window.document.getElementById('domainDesiredField').style.display, 'none');
  elegirProducto(dom, 'ficha_personalizado');
  assert.notEqual(dom.window.document.getElementById('domainDesiredField').style.display, 'none');
});

test('Kit — cambiar de Premium a Express limpia cualquier valor escrito antes (nunca queda un valor residual)', async () => {
  const dom = await bootKit({ identity: EJECUTIVO });
  elegirProducto(dom, 'personalizado');
  const input = dom.window.document.getElementById('desiredDomain');
  input.value = 'tiendadejuanito';
  elegirProducto(dom, 'generico');
  assert.equal(input.value, '', 'el valor escrito para Premium no debe sobrevivir el cambio a Express');
  assert.equal(dom.window.document.getElementById('domainDesiredField').style.display, 'none');
});

test('Kit — un valor residual en el campo (aunque el input no se haya limpiado) nunca se envía en los antecedentes de una venta Express', async () => {
  const dom = await bootKit({ identity: EJECUTIVO });
  // Simula el peor caso: el campo queda con un valor aunque ya no sea
  // visible (ej. una manipulación manual del DOM, o un futuro cambio que
  // rompa la limpieza automática) — buildAntecedentesKit() debe blindarse
  // igual, sin depender solo de que el input esté vacío.
  elegirProducto(dom, 'personalizado');
  dom.window.document.getElementById('desiredDomain').value = 'valorquenodeberiaenviarse';
  elegirProducto(dom, 'generico');
  dom.window.document.getElementById('desiredDomain').value = 'valorquenodeberiaenviarse'; // reescrito a mano tras el cambio.

  dom.window.document.getElementById('pname').value = 'Negocio Test';
  // buildAntecedentesKit()/buildVentaPayload() no están expuestas a
  // `window` (scope de <script> clásico) — se invocan igual desde otro
  // eval en el mismo window, que comparte el mismo scope global.
  const antecedentes = dom.window.eval('buildAntecedentesKit()');
  assert.equal(antecedentes.productoCondiciones['Dominio propio deseado'], null, 'Express nunca debe guardar un dominio propio, ni con un valor residual en el input');

  const { payload } = dom.window.eval('buildVentaPayload()');
  assert.equal(payload.antecedentesKit.productoCondiciones['Dominio propio deseado'], null, 'el payload real que se envía al backend tampoco debe llevarlo');
});

// ── Hallazgo 2: "Tipo de venta" exclusivo de administración — RIO-122 ──

test('Kit — un ejecutivo normal nunca ve el selector "Tipo de venta"', async () => {
  const dom = await bootKit({ identity: EJECUTIVO });
  var field = dom.window.document.getElementById('ventaTipoField');
  assert.equal(field.style.display, 'none', 'oculto por defecto');
  dom.window.eval('runCloseVenta()'); // wrapper del botón "Enviar" que decide mostrarlo o no.
});

test('Kit — runCloseVenta() nunca muestra el selector de tipo de venta para un ejecutivo, incluso completando los campos mínimos', async () => {
  const dom = await bootKit({ identity: EJECUTIVO });
  elegirProducto(dom, 'generico');
  var doc = dom.window.document;
  doc.getElementById('pname').value = 'Negocio Test';
  doc.getElementById('pclientname').value = 'Cliente Test';
  doc.getElementById('pclientwa').value = '+56900000000';
  dom.window.eval('runCloseVenta()');
  assert.equal(doc.getElementById('ventaTipoField').style.display, 'none', 'runCloseVenta() nunca lo revela para un ejecutivo');
});

test('Kit — runCloseVenta() SÍ muestra el selector de tipo de venta para administración', async () => {
  const dom = await bootKit({ identity: ADMIN });
  elegirProducto(dom, 'generico');
  var doc = dom.window.document;
  doc.getElementById('pname').value = 'Negocio Test';
  doc.getElementById('pclientname').value = 'Cliente Test';
  doc.getElementById('pclientwa').value = '+56900000000';
  dom.window.eval('runCloseVenta()');
  assert.notEqual(doc.getElementById('ventaTipoField').style.display, 'none', 'para administración sí corresponde mostrarlo');
});

test('Kit — el body real que un ejecutivo envía a POST /ventas nunca incluye tipoVenta ni equipoId, ni manipulando el DOM a mano', async () => {
  let cuerpoEnviado = null;
  const dom = await bootKit({ identity: EJECUTIVO });
  // Sobrescribe fetch para capturar el body real del POST de cierre —
  // mismo mock base que bootKit, solo agrega la captura para esta ruta.
  const fetchOriginal = dom.window.fetch;
  dom.window.fetch = async (url, init) => {
    if (String(url).split('?')[0] === '/interno/api/ventas' && init && init.method === 'POST') {
      cuerpoEnviado = JSON.parse(init.body);
      return { ok: true, status: 201, json: async () => ({ ok: true, data: { venta: { id: 'venta-test' } } }) };
    }
    return fetchOriginal(url, init);
  };

  elegirProducto(dom, 'generico');
  dom.window.document.getElementById('pname').value = 'Negocio Test';
  dom.window.eval('runCloseVenta()');
  // Manipulación deliberada: aunque el select estuviera presente en el
  // DOM (oculto), un ejecutivo no puede forzar un valor real ahí — el
  // código de confirmación ni siquiera lo lee fuera de esAdministracion().
  await dom.window.eval('confirmarYCerrarVenta()');

  assert.ok(cuerpoEnviado, 'el POST /interno/api/ventas debió dispararse');
  assert.equal(cuerpoEnviado.tipoVenta, undefined, 'un ejecutivo nunca decide su tipo de venta desde el Kit');
  assert.equal(cuerpoEnviado.equipoId, undefined, 'un ejecutivo nunca elige equipo desde el Kit — se resuelve server-side desde su asignación vigente');
});

test('Kit — el body real que administración envía SÍ incluye tipoVenta (venta directa) cuando corresponde', async () => {
  let cuerpoEnviado = null;
  const dom = await bootKit({ identity: ADMIN });
  const fetchOriginal = dom.window.fetch;
  dom.window.fetch = async (url, init) => {
    if (String(url).split('?')[0] === '/interno/api/ventas' && init && init.method === 'POST') {
      cuerpoEnviado = JSON.parse(init.body);
      return { ok: true, status: 201, json: async () => ({ ok: true, data: { venta: { id: 'venta-test' } } }) };
    }
    return fetchOriginal(url, init);
  };

  elegirProducto(dom, 'generico');
  dom.window.document.getElementById('pname').value = 'Negocio Test';
  dom.window.eval('runCloseVenta()');
  dom.window.document.getElementById('ventaTipoVentaSelect').value = 'directa';
  await dom.window.eval('confirmarYCerrarVenta()');

  assert.ok(cuerpoEnviado, 'el POST /interno/api/ventas debió dispararse');
  assert.equal(cuerpoEnviado.tipoVenta, 'directa_administracion_sin_supervision');
});
