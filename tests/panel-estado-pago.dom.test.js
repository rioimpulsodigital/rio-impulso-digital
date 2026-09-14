// Pruebas de DOM real (jsdom) — RIO-122, segunda corrección de UAT
// (13/09/2026). La primera corrección de RIO-122 solo probó el CONTRATO
// de la API (estadoPagoResumen/fueRechazado, ver tests/ventas.test.js) —
// Brenda reportó que, pese a eso, la tabla principal de los 3 paneles
// seguía mostrando "En espera de pago" mientras el detalle ya mostraba
// "Informado". Causa real: el `?v=` de cada panel-*.js no se actualizó
// al corregirlo, así que el navegador siguió sirviendo el JS viejo desde
// caché — el texto que un usuario real recibe en la tabla nunca se
// verificó, solo la respuesta de la API. Estas pruebas cargan el HTML
// real de cada panel en jsdom, ejecutan su JS real (sin mockear la
// función de etiqueta) y leen el texto efectivamente renderizado en la
// fila de la tabla — lo mismo que vería Brenda en el navegador.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESTADO_PAGO_JS = fs.readFileSync(path.join(ROOT, 'interno/config/estado-pago.js'), 'utf8');

function flush(ticks = 12) {
  return new Promise((resolve) => {
    let n = 0;
    function tick() { n += 1; if (n >= ticks) resolve(); else setTimeout(tick, 0); }
    tick();
  });
}

// Arranca un panel real: HTML real + config/estado-pago.js real + JS del
// panel real, con `fetch` mockeado a rutas explícitas — nunca se
// reimplementa `estadoVentaVisibleLabel` ni ninguna otra función del
// panel, se ejecuta la de verdad.
async function bootPanel({ htmlFile, jsFile, identity, ventas, extraRoutes = {} }) {
  const html = fs.readFileSync(path.join(ROOT, 'interno', htmlFile), 'utf8');
  const panelSrc = fs.readFileSync(path.join(ROOT, 'interno', jsFile), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://rioimpulsodigital.com/interno/' + htmlFile,
    pretendToBeVisual: true,
    // "outside-only": no ejecuta automáticamente los <script src> del
    // HTML (evita que jsdom intente resolver rutas de archivo por su
    // cuenta) pero SÍ habilita window.eval()/Function() con acceso real
    // al `document`/`window` de este DOM — necesario para ejecutar acá
    // mismo el JS real de cada panel.
    runScripts: 'outside-only',
  });

  const routes = Object.assign({
    '/interno/api/identidad/whoami': () => ({ ok: true, data: identity }),
    '/interno/api/ventas': () => ({ ok: true, data: { ventas } }),
    '/interno/api/identidad/referente': () => ({ ok: true, data: { referentes: [] } }),
    '/interno/api/notificaciones': () => ({ ok: true, data: { notificaciones: [] } }),
    '/interno/api/equipos': () => ({ ok: true, data: { equipos: [] } }),
  }, extraRoutes);

  dom.window.fetch = async (url) => {
    const rutaSinQuery = String(url).split('?')[0];
    const handler = routes[rutaSinQuery];
    if (!handler) throw new Error('ruta no mockeada en el test: ' + url);
    const body = handler();
    return { ok: true, status: 200, json: async () => body };
  };

  dom.window.eval(ESTADO_PAGO_JS);
  dom.window.eval(panelSrc);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
  await flush();
  return dom;
}

function filaTexto(dom, codigoVenta) {
  const filas = [...dom.window.document.querySelectorAll('#pvVentasResult tbody tr')];
  const fila = filas.find((tr) => tr.textContent.indexOf(codigoVenta) !== -1);
  return fila ? fila.textContent : null;
}

function ventaBase(overrides) {
  return Object.assign({
    id: 'venta-1', codigoVenta: 'V-TEST', cliente: { negocio: 'Peluquería Canina' },
    mercado: 'CL', producto: 'ficha', moneda: 'CLP', tipoPrecio: 'lanzamiento', precioPactado: 60000,
    vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba',
    equipoId: null, equipoNombre: null, supervisorNombre: null,
    tipoVenta: 'equipo', supervisionAplica: false, motivoSinSupervision: null,
    estadoActual: 'registrada', proyectoEstado: 'registrado',
    estadoOperativo: 'en_espera_pago', estadoPagoResumen: 'pendiente', estadoMaterialesResumen: 'pendiente',
    origen: 'kit_comercial', esDemo: false,
    nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
    distribucionSnapshot: null, modoHistorico: null,
    createdAt: '2026-09-13 00:00:00',
  }, overrides);
}

const IDENTIDAD_VENDEDOR = { email: 'vendedor@example.com', nombre: 'Vendedor de Prueba', role: 'ejecutivo', permissions: { viewOthersData: false } };
const IDENTIDAD_SUPERVISOR = { email: 'supervisor@example.com', nombre: 'Supervisora de Prueba', role: 'supervisor', permissions: { viewOthersData: 'sameMarketOnly' } };
const IDENTIDAD_ADMIN = { email: 'admin@example.com', nombre: 'Admin de Prueba', role: 'admin', permissions: { viewOthersData: true, manageUsers: true } };

const PANELES = [
  { nombre: 'Vendedor', htmlFile: 'panel-vendedor.html', jsFile: 'panel-vendedor.js', identity: IDENTIDAD_VENDEDOR },
  { nombre: 'Supervisor', htmlFile: 'panel-supervisor.html', jsFile: 'panel-supervisor.js', identity: IDENTIDAD_SUPERVISOR },
  { nombre: 'Administrativo', htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN },
];

// ── Los 4 escenarios mínimos exigidos, en cada uno de los 3 paneles ────

for (const panel of PANELES) {
  test(`Panel ${panel.nombre} — tabla: pago nunca informado se muestra como "En espera de pago"`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-NUNCA-INFORMADO', estadoPagoResumen: 'pendiente' });
    const dom = await bootPanel({ ...panel, ventas: [venta] });
    const texto = filaTexto(dom, 'V-NUNCA-INFORMADO');
    assert.ok(texto, 'la fila debe existir en la tabla');
    assert.ok(texto.includes('En espera de pago'), 'texto real de la fila: ' + texto);
    assert.ok(!texto.includes('Pago informado'), 'un pago nunca informado nunca debe leerse como informado');
    assert.ok(!texto.includes('rechazado'), 'un pago nunca informado nunca debe leerse como rechazado');
  });

  test(`Panel ${panel.nombre} — tabla: pago informado se muestra como "Pago informado — pendiente de validación" (caso UAT Peluquería Canina)`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-20260903-967F6E', cliente: { negocio: 'Peluquería Canina' }, estadoPagoResumen: 'informado' });
    const dom = await bootPanel({ ...panel, ventas: [venta] });
    const texto = filaTexto(dom, 'V-20260903-967F6E');
    assert.ok(texto, 'la fila debe existir en la tabla');
    assert.ok(texto.includes('Pago informado — pendiente de validación'), 'texto real de la fila: ' + texto);
    assert.ok(!texto.includes('En espera de pago'), 'la tabla no debe contradecir el detalle (que ya muestra informado)');
  });

  test(`Panel ${panel.nombre} — tabla: pago rechazado se muestra como "Pago rechazado — requiere corrección"`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-RECHAZADO', estadoPagoResumen: 'rechazado' });
    const dom = await bootPanel({ ...panel, ventas: [venta] });
    const texto = filaTexto(dom, 'V-RECHAZADO');
    assert.ok(texto.includes('Pago rechazado — requiere corrección'), 'texto real de la fila: ' + texto);
    assert.ok(!texto.includes('Pago informado'));
    assert.ok(!texto.includes('En espera de pago'));
  });

  test(`Panel ${panel.nombre} — tabla: pago confirmado (acreditado) ya no se muestra como "en espera de pago"`, async () => {
    const venta = ventaBase({
      codigoVenta: 'V-CONFIRMADO', estadoPagoResumen: 'acreditado',
      // Una vez acreditado, el AVANCE OPERATIVO real deja de ser
      // 'en_espera_pago' (RIO-117) — el backend nunca envía la
      // combinación estadoOperativo='en_espera_pago' + estadoPagoResumen
      // ='acreditado' (ver calcularEstadoOperativo en ventas/index.js).
      estadoOperativo: 'registrado',
    });
    const dom = await bootPanel({ ...panel, ventas: [venta] });
    const texto = filaTexto(dom, 'V-CONFIRMADO');
    assert.ok(texto, 'la fila debe existir en la tabla');
    assert.ok(!texto.includes('En espera de pago'));
    assert.ok(!texto.includes('rechazado'));
    assert.ok(texto.includes('Registrado'), 'sin texto especial: se muestra el siguiente estado operativo real — texto real: ' + texto);
  });

  // ── Secuencia exacta reportada por Brenda: informado → rechazado →
  // nuevo comprobante → informado — la tabla debe reflejar el estado
  // FINAL (informado), nunca quedar "pegada" en un estado anterior. ────
  test(`Panel ${panel.nombre} — secuencia rechazo→nuevo comprobante→informado: tabla y filtro coinciden con el detalle (INFORMADO)`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-20260903-967F6E', cliente: { negocio: 'Peluquería Canina' }, estadoPagoResumen: 'informado' });
    const dom = await bootPanel({
      ...panel, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({
          ok: true,
          data: {
            venta: { id: 'venta-1', codigoVenta: venta.codigoVenta, vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre },
            cliente: { negocio: 'Peluquería Canina' },
            proyecto: { estadoActual: 'registrado' },
            componentes: [],
            // Detalle real: el pago quedó 'informado' tras la secuencia
            // rechazo→nuevo comprobante→informado — fueRechazado es
            // false porque el estado actual ya no es 'pendiente'.
            pagosEsperados: [{ id: 'pago-1', tipo: 'total', monto: 60000, moneda: 'CLP', estado: 'informado', fueRechazado: false }],
          },
        }),
      },
    });

    // 1) Tabla — texto real que ve el usuario.
    const textoTabla = filaTexto(dom, 'V-20260903-967F6E');
    assert.ok(textoTabla.includes('Pago informado — pendiente de validación'), 'tabla real: ' + textoTabla);
    assert.ok(!textoTabla.includes('En espera de pago'), 'la tabla no debe quedar pegada en un estado anterior al rechazo');

    // 2) Detalle — mismo criterio que ya prueba tests/ventas.test.js a
    // nivel de API, ahora confirmado contra el JSON que el panel
    // efectivamente usaría para pintar el detalle.
    const detalleResp = await dom.window.fetch('/interno/api/ventas/venta-1');
    const detalle = (await detalleResp.json()).data;
    assert.equal(detalle.pagosEsperados[0].estado, 'informado');
    assert.equal(detalle.pagosEsperados[0].fueRechazado, false);

    // 3) Filtro "Estado de pago" — la venta debe aparecer entre las
    // informadas y desaparecer de "pendiente"/"rechazado".
    const selectPago = dom.window.document.getElementById('fPago');
    assert.ok(selectPago, 'el panel debe tener el filtro "Estado de pago"');

    selectPago.value = 'informado';
    selectPago.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.ok(filaTexto(dom, 'V-20260903-967F6E'), 'con el filtro "informado" la venta debe seguir visible');

    selectPago.value = 'pendiente';
    selectPago.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(filaTexto(dom, 'V-20260903-967F6E'), null, 'con el filtro "pendiente" NO debe aparecer — no es un pago nunca informado');

    selectPago.value = 'rechazado';
    selectPago.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(filaTexto(dom, 'V-20260903-967F6E'), null, 'con el filtro "rechazado" NO debe aparecer — ya fue corregido');

    selectPago.value = '';
    selectPago.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.ok(filaTexto(dom, 'V-20260903-967F6E'), 'sin filtro, vuelve a aparecer');
  });

  test(`Panel ${panel.nombre} — la columna Estado nunca contradice el detalle: mismo criterio (estadoPagoResumen) para ambos`, async () => {
    // Prueba de coherencia general con varias ventas a la vez — ninguna
    // combinación produce una etiqueta de tabla que no corresponda a
    // estadoPagoResumen.
    const ventas = [
      ventaBase({ id: 'v1', codigoVenta: 'V-1', estadoPagoResumen: 'pendiente' }),
      ventaBase({ id: 'v2', codigoVenta: 'V-2', estadoPagoResumen: 'informado' }),
      ventaBase({ id: 'v3', codigoVenta: 'V-3', estadoPagoResumen: 'rechazado' }),
    ];
    const dom = await bootPanel({ ...panel, ventas });
    assert.ok(filaTexto(dom, 'V-1').includes('En espera de pago'));
    assert.ok(filaTexto(dom, 'V-2').includes('Pago informado — pendiente de validación'));
    assert.ok(filaTexto(dom, 'V-3').includes('Pago rechazado — requiere corrección'));
  });
}
