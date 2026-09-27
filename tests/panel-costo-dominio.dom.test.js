// Pruebas de DOM real (jsdom) — RIO-122 (19/09/2026), no mostrar el
// bloque "Registrar costo directo (ej. dominio propio)" en una Landing
// que no requiere dominio propio (genérica/Express). El costo del
// dominio solo corresponde a Landing Premium (planes con dominio propio
// incluido) — Landing Express usa el dominio de RiO, nunca compra uno
// propio para el cliente. Mismo criterio exacto ya usado por el backend
// (`requiereDominio` en functions/interno/api/ventas/[id].js), aplicado
// también en el frontend para no mostrar el formulario cuando no
// corresponde.
//
// Panel Vendedor y Panel Supervisor nunca mostraron este bloque (acción
// exclusiva de administración) — no necesitan cambios ni pruebas nuevas.

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

async function bootPanel({ htmlFile, jsFile, identity, ventas, extraRoutes = {} }) {
  const html = fs.readFileSync(path.join(ROOT, 'interno', htmlFile), 'utf8');
  const panelSrc = fs.readFileSync(path.join(ROOT, 'interno', jsFile), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://rioimpulsodigital.com/interno/' + htmlFile,
    pretendToBeVisual: true,
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

function ventaBase(overrides) {
  return Object.assign({
    id: 'venta-1', codigoVenta: 'V-TEST', cliente: { negocio: 'Peluquería Canina' },
    mercado: 'CL', producto: 'generico', moneda: 'CLP', tipoPrecio: 'lanzamiento', precioPactado: 60000,
    vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba',
    equipoId: null, equipoNombre: null, supervisorNombre: null,
    tipoVenta: 'equipo', supervisionAplica: false, motivoSinSupervision: null,
    estadoActual: 'registrada', proyectoEstado: 'en_produccion',
    estadoOperativo: 'en_produccion', estadoPagoResumen: 'acreditado', estadoMaterialesResumen: 'pendiente',
    origen: 'kit_comercial', esDemo: false,
    nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
    distribucionSnapshot: null, modoHistorico: null,
    createdAt: '2026-09-19 00:00:00',
  }, overrides);
}

function componenteLanding(overrides) {
  return Object.assign({
    id: 'comp-landing', tipo: 'landing', nombre: null, descripcion: null,
    precioIndividualReferencia: 60000, precioAtribuido: 60000,
    estadoActual: 'en_produccion', materialesEstado: 'pendiente', orden: null,
    responsableOperativoEmail: null, fechaPrevista: null, fechaReal: null,
    materialesInformes: [], materialesConfirmaciones: [], costoDominioPendiente: false,
  }, overrides);
}

function componenteFicha(overrides) {
  return Object.assign({
    id: 'comp-ficha', tipo: 'ficha', nombre: null, descripcion: null,
    precioIndividualReferencia: 60000, precioAtribuido: 60000,
    estadoActual: 'en_produccion', materialesEstado: 'pendiente', orden: null,
    responsableOperativoEmail: null, fechaPrevista: null, fechaReal: null,
    materialesInformes: [], materialesConfirmaciones: [], costoDominioPendiente: false,
  }, overrides);
}

function detalleBase({ producto, componentes }) {
  return {
    venta: {
      id: 'venta-1', codigoVenta: 'V-TEST', mercado: 'CL', producto, moneda: 'CLP',
      precioPactado: 60000, vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba',
      estadoActual: 'registrada', estadoOperativo: 'en_produccion', estadoPagoResumen: 'acreditado',
      createdAt: '2026-09-19 00:00:00', tipoVenta: 'equipo', equipoId: null, equipoNombre: null,
      supervisorEmail: null, supervisorNombre: null, supervisionAplica: false, motivoSinSupervision: null,
      porcentajeSupervisionAplicado: 0, nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
      distribucionSnapshot: null, modoHistorico: null, proximaAccion: null, responsableProximaAccion: null,
      antecedentesKit: null,
    },
    cliente: { id: 'cliente-1', negocio: 'Peluquería Canina', contactoNombre: null, telefono: null, email: null, datosFacturacionAr: null },
    proyecto: { id: 'proyecto-1', codigoProyecto: 'P-1', estadoActual: 'en_produccion' },
    componentes,
    pagosEsperados: [],
  };
}

const IDENTIDAD_ADMIN = { email: 'admin@example.com', nombre: 'Admin de Prueba', role: 'admin', permissions: { viewOthersData: true, manageUsers: true } };

async function abrirFicha(dom, ventaId) {
  const tr = [...dom.window.document.querySelectorAll('#pvVentasResult tbody tr')].find((r) => r.getAttribute('data-venta-id') === ventaId);
  assert.ok(tr, 'la fila de la venta debe existir');
  tr.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();
  return dom.window.document.getElementById('pvDetailBody');
}

// ── Landing genérica / Express — NO corresponde ────────────────────────

for (const producto of ['generico', 'ficha_generico']) {
  test(`Panel Administrativo — producto '${producto}' (Landing Express/genérica): NO se muestra "Registrar costo directo"`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-EXPRESS-' + producto, producto });
    const componentes = producto === 'ficha_generico' ? [componenteFicha({ id: 'comp-ficha' }), componenteLanding({ id: 'comp-landing' })] : [componenteLanding({ id: 'comp-landing' })];
    const detalle = detalleBase({ producto, componentes });
    const dom = await bootPanel({
      htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });
    const body = await abrirFicha(dom, 'venta-1');
    assert.equal(body.querySelector('form[data-costo-directo]'), null, `no debe existir el formulario de costo directo para '${producto}': ` + body.textContent);
    assert.ok(!body.textContent.includes('Registrar costo directo'), 'no debe mencionar "Registrar costo directo": ' + body.textContent);
  });
}

// ── Landing Premium / dominio propio — SÍ corresponde ──────────────────

for (const producto of ['personalizado', 'ficha_personalizado']) {
  test(`Panel Administrativo — producto '${producto}' (Landing Premium): SÍ se muestra "Registrar costo directo" en la Landing`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-PREMIUM-' + producto, producto });
    const componentes = producto === 'ficha_personalizado' ? [componenteFicha({ id: 'comp-ficha' }), componenteLanding({ id: 'comp-landing' })] : [componenteLanding({ id: 'comp-landing' })];
    const detalle = detalleBase({ producto, componentes });
    const dom = await bootPanel({
      htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });
    const body = await abrirFicha(dom, 'venta-1');
    const forms = [...body.querySelectorAll('form[data-costo-directo]')];
    assert.equal(forms.length, 1, `debe existir exactamente 1 formulario de costo directo (solo en la Landing) para '${producto}': ` + body.textContent);
    assert.equal(forms[0].getAttribute('data-costo-directo'), 'comp-landing', 'el formulario debe pertenecer al componente Landing, no a Ficha');
    assert.ok(body.textContent.includes('Registrar costo directo'), 'debe mencionar "Registrar costo directo": ' + body.textContent);
  });
}
