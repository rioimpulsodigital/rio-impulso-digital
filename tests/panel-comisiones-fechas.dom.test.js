// Pruebas de DOM real (jsdom) — RIO-122, hallazgo 15 (15/09/2026,
// confirmación IAn). El calendario aprobado de comisiones
// (calcularFechaProgramada, RIO-97 v2 sección 8: 26→10 del mes vigente/
// siguiente paga el 25, 11→25 paga el 10 del mes siguiente) NO se toca —
// ya está probado a fondo en tests/comisiones.test.js. Lo que se corrige
// acá es la presentación: confirmar que la fecha programada que el
// backend YA calcula llega hasta la columna "Fechas" del Panel del
// Vendedor, con el mismo formato de fecha que el resto del Portal — nunca
// se calcula nada nuevo en el navegador.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESTADO_PAGO_JS = fs.readFileSync(path.join(ROOT, 'interno/config/estado-pago.js'), 'utf8');
const PANEL_SRC = fs.readFileSync(path.join(ROOT, 'interno/panel-vendedor.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'interno/panel-vendedor.html'), 'utf8');

function flush(ticks = 15) {
  return new Promise((resolve) => {
    let n = 0;
    function tick() { n += 1; if (n >= ticks) resolve(); else setTimeout(tick, 0); }
    tick();
  });
}

async function bootPanel({ identity, ventas, comisionesPorVenta = {} }) {
  const dom = new JSDOM(HTML, {
    url: 'https://rioimpulsodigital.com/interno/panel-vendedor.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const routes = {
    '/interno/api/identidad/whoami': () => ({ ok: true, data: identity }),
    '/interno/api/ventas': () => ({ ok: true, data: { ventas } }),
    '/interno/api/identidad/referente': () => ({ ok: true, data: { referentes: [] } }),
    '/interno/api/notificaciones': () => ({ ok: true, data: { notificaciones: [] } }),
    '/interno/api/equipos': () => ({ ok: true, data: { equipos: [] } }),
  };
  ventas.forEach((v) => {
    routes['/interno/api/ventas/' + v.id + '/comisiones'] = () => ({ ok: true, data: { comisiones: comisionesPorVenta[v.id] || [] } });
  });

  dom.window.fetch = async (url) => {
    const rutaSinQuery = String(url).split('?')[0];
    const handler = routes[rutaSinQuery];
    if (!handler) throw new Error('ruta no mockeada en el test: ' + url);
    return { ok: true, status: 200, json: async () => handler() };
  };

  dom.window.eval(ESTADO_PAGO_JS);
  dom.window.eval(PANEL_SRC);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
  await flush();
  return dom;
}

async function abrirMisComisiones(dom) {
  const btn = dom.window.document.getElementById('pvTabComisionesBtn');
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();
}

const IDENTIDAD = { email: 'vendedor@example.com', nombre: 'Vendedor de Prueba', role: 'ejecutivo', permissions: { viewOthersData: false } };

function ventaBase(overrides) {
  return Object.assign({
    id: 'venta-1', codigoVenta: 'V-20260915-AF1A59', cliente: { negocio: 'Negocio Test 14B' },
    mercado: 'CL', producto: 'generico', moneda: 'CLP', tipoPrecio: 'lanzamiento', precioPactado: 50000,
    vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba',
    equipoId: null, equipoNombre: null, supervisorNombre: null,
    tipoVenta: 'equipo', supervisionAplica: false, motivoSinSupervision: null,
    estadoActual: 'registrada', proyectoEstado: 'registrado',
    estadoOperativo: 'en_espera_pago', estadoPagoResumen: 'pendiente', estadoMaterialesResumen: 'pendiente',
    origen: 'kit_comercial', esDemo: false,
    nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
    distribucionSnapshot: null, modoHistorico: null,
    createdAt: '2026-09-15 00:00:00',
  }, overrides);
}

function comisionBase(overrides) {
  return Object.assign({
    id: 'com-1', tipo: 'comercial', componenteId: null, beneficiarioEmail: 'vendedor@example.com', beneficiarioNombre: 'Vendedor de Prueba',
    porcentaje: 40, base: 'utilidad_neta_venta', montoBase: 50000, moneda: 'CLP', montoComision: 20000,
    estado: 'calculada_provisional',
    fechaInicioPlazo: null, fechaCumplimientoPlazo: null, fechaPagoTotalAcreditado: null, fechaHabilitacion: null,
    fechaProgramadaOriginal: null, fechaProgramadaEfectiva: null, fechaPagoReal: null,
    motivoRetencionOReprogramacion: null, costoDominioPendiente: false,
  }, overrides);
}

test('Panel Vendedor — Mis comisiones: sin fecha programada todavía (solo estimación), la columna Fechas muestra "—"', async () => {
  const venta = ventaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: { 'venta-1': [comisionBase({})] },
  });
  await abrirMisComisiones(dom);
  const texto = dom.window.document.getElementById('pvComisionesResult').textContent;
  assert.ok(texto.includes('Negocio Test 14B'), 'la fila de la comisión debe estar visible: ' + texto);
  assert.ok(texto.includes('—'), 'sin fecha programada todavía, debe mostrar "—": ' + texto);
  assert.ok(!texto.includes('Programada'), 'nunca debe inventar una fecha cuando el backend no envió ninguna');
});

test('Panel Vendedor — Mis comisiones: caso Negocio Test 14B con fecha programada real (10 oct 2026, tramo 11-25 -> 10 del mes siguiente) se muestra en la columna Fechas', async () => {
  const venta = ventaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: {
      'venta-1': [comisionBase({
        estado: 'programada',
        fechaHabilitacion: '2026-09-15 10:00:00',
        fechaProgramadaOriginal: '2026-10-10',
        fechaProgramadaEfectiva: '2026-10-10',
      })],
    },
  });
  await abrirMisComisiones(dom);
  const texto = dom.window.document.getElementById('pvComisionesResult').textContent;
  assert.ok(texto.includes('Programada (original)'), 'texto real: ' + texto);
  assert.ok(/10\s*(de\s*)?oct/i.test(texto), 'debe mostrar la fecha con el mismo formato legible del resto del Portal (no la fecha SQL cruda "2026-10-10"): ' + texto);
  assert.ok(!texto.includes('2026-10-10'), 'nunca debe mostrarse la fecha SQL cruda sin formatear: ' + texto);
});

test('Panel Vendedor — Mis comisiones: fecha original vs. efectiva (reprogramación) se muestran ambas cuando difieren', async () => {
  const venta = ventaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: {
      'venta-1': [comisionBase({
        estado: 'programada',
        fechaProgramadaOriginal: '2026-10-10',
        fechaProgramadaEfectiva: '2026-10-24',
        motivoRetencionOReprogramacion: 'Reprogramada tras resolverse la disputa que la retuvo.',
      })],
    },
  });
  await abrirMisComisiones(dom);
  const texto = dom.window.document.getElementById('pvComisionesResult').textContent;
  assert.ok(texto.includes('Programada (original)'), 'texto real: ' + texto);
  assert.ok(texto.includes('Programada (efectiva)'), 'cuando difiere de la original, la efectiva también debe mostrarse: ' + texto);
  assert.ok(texto.includes('Reprogramada tras resolverse la disputa que la retuvo.'), 'el motivo de la reprogramación debe seguir visible');
});

test('Panel Vendedor — Mis comisiones: una comisión ya pagada muestra la fecha real de pago, separada de la programada', async () => {
  const venta = ventaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: {
      'venta-1': [comisionBase({
        estado: 'pagada',
        fechaProgramadaOriginal: '2026-10-10',
        fechaProgramadaEfectiva: '2026-10-10',
        fechaPagoReal: '2026-10-10 15:30:00',
      })],
    },
  });
  await abrirMisComisiones(dom);
  const texto = dom.window.document.getElementById('pvComisionesResult').textContent;
  assert.ok(texto.includes('Programada (original)'), 'la fecha programada sigue visible incluso ya pagada: ' + texto);
  assert.ok(texto.includes('Pago real'), 'la fecha real de pago debe mostrarse separada de la programada: ' + texto);
});
