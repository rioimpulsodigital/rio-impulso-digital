// Pruebas de DOM real (jsdom) — RIO-122 (19/09/2026), cierre operativo de
// la etapa de comprobante. Mismo patrón de ruido que la etapa de
// materiales (ver tests/panel-materiales-cierre.dom.test.js): aunque el
// pago ya estuviera ACREDITADO, el Portal seguía mostrando el selector de
// archivo y el botón "Subir corrección (nueva versión)" en Panel
// Vendedor, dando a entender que faltaba algo aunque administración ya
// hubiera validado el pago definitivamente.
//
// Regla: la etapa de comprobante queda abierta mientras `pago.estado` sea
// 'pendiente' (nunca informado o rechazado, esperando corrección) o
// 'informado' (comprobante subido, esperando validación) — se cierra en
// 'acreditado'. El comprobante ya validado (nombre, versión) sigue
// siempre visible; solo desaparecen las acciones de carga.
//
// Panel Administrativo: su acción de "corrección de comprobante" es
// "Rechazar / solicitar un comprobante nuevo" (data-rechazar-pago) — ya
// estaba correctamente cerrada en 'acreditado' desde antes de esta
// corrección (panel-administrativo.js:1331); esta suite agrega una
// prueba de regresión para dejarlo fijado, sin tocar código ahí.
//
// Panel Supervisor: nunca mostró ninguna acción de comprobante (de solo
// lectura desde su diseño original, RIO-118) — no necesita cambios ni
// pruebas nuevas acá.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESTADO_PAGO_JS = fs.readFileSync(path.join(ROOT, 'interno/config/estado-pago.js'), 'utf8');
// RIO-122 (22/09/2026): necesario para las pruebas de la pestaña
// Liquidaciones de Panel Administrativo, que ya lo carga en producción
// (panel-administrativo.html) antes de panel-administrativo.js.
const ESTADO_DOCUMENTAL_JS = fs.readFileSync(path.join(ROOT, 'interno/config/estado-documental.js'), 'utf8');

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
  dom.window.eval(ESTADO_DOCUMENTAL_JS);
  dom.window.eval(panelSrc);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
  await flush();
  return dom;
}

function ventaBase(overrides) {
  return Object.assign({
    id: 'venta-1', codigoVenta: 'V-TEST', cliente: { negocio: 'Peluquería Canina' },
    mercado: 'CL', producto: 'ficha', moneda: 'CLP', tipoPrecio: 'lanzamiento', precioPactado: 60000,
    vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba',
    equipoId: null, equipoNombre: null, supervisorNombre: null,
    tipoVenta: 'equipo', supervisionAplica: false, motivoSinSupervision: null,
    estadoActual: 'registrada', proyectoEstado: 'en_produccion',
    estadoOperativo: 'en_produccion', estadoPagoResumen: 'acreditado', estadoMaterialesResumen: 'pendiente',
    origen: 'kit_comercial', esDemo: false,
    nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
    distribucionSnapshot: null, modoHistorico: null,
    createdAt: '2026-09-17 00:00:00',
  }, overrides);
}

function detalleBase({ vendedorEmail, vendedorNombre, pago }) {
  return {
    venta: {
      id: 'venta-1', codigoVenta: 'V-TEST', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
      precioPactado: 60000, vendedorEmail, vendedorNombre,
      estadoActual: 'registrada', estadoOperativo: 'en_produccion', estadoPagoResumen: pago.estado,
      createdAt: '2026-09-17 00:00:00', tipoVenta: 'equipo', equipoId: null, equipoNombre: null,
      supervisorEmail: null, supervisorNombre: null, supervisionAplica: false, motivoSinSupervision: null,
      porcentajeSupervisionAplicado: 0, nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
      distribucionSnapshot: null, modoHistorico: null, proximaAccion: null, responsableProximaAccion: null,
      antecedentesKit: null,
    },
    cliente: { id: 'cliente-1', negocio: 'Peluquería Canina', contactoNombre: null, telefono: null, email: null, datosFacturacionAr: null },
    proyecto: { id: 'proyecto-1', codigoProyecto: 'P-1', estadoActual: 'en_produccion' },
    componentes: [{
      id: 'comp-1', tipo: 'ficha', nombre: null, descripcion: null,
      precioIndividualReferencia: 60000, precioAtribuido: 60000,
      estadoActual: 'en_produccion', materialesEstado: 'pendiente', orden: null,
      responsableOperativoEmail: null, fechaPrevista: null, fechaReal: null,
      materialesInformes: [], materialesConfirmaciones: [], costoDominioPendiente: false,
    }],
    pagosEsperados: [pago],
  };
}

function pagoBase(overrides) {
  return Object.assign({
    id: 'pago-1', tipo: 'total', etiqueta: null, monto: 60000, moneda: 'CLP',
    estado: 'informado', hitoValidado: false, hitoValidadoPor: null, hitoValidadoAt: null,
    hitoNota: null, fueRechazado: false,
  }, overrides);
}

const IDENTIDAD_VENDEDOR = { email: 'vendedor@example.com', nombre: 'Vendedor de Prueba', role: 'ejecutivo', permissions: { viewOthersData: false } };
const IDENTIDAD_ADMIN = { email: 'admin@example.com', nombre: 'Admin de Prueba', role: 'admin', permissions: { viewOthersData: true, manageUsers: true } };

async function abrirFicha(dom, ventaId) {
  const tr = [...dom.window.document.querySelectorAll('#pvVentasResult tbody tr')].find((r) => r.getAttribute('data-venta-id') === ventaId);
  assert.ok(tr, 'la fila de la venta debe existir');
  tr.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();
  return dom.window.document.getElementById('pvDetailBody');
}

function comprobanteRoute(comprobante) {
  return () => ({ ok: true, data: { comprobante } });
}

// ── Panel Vendedor ──────────────────────────────────────────────────────

test('Panel Vendedor — pago "pendiente" (nunca informado): sin selector de archivo, se informa el pago primero', async () => {
  const venta = ventaBase({ codigoVenta: 'V-NUNCA-INFORMADO' });
  const pago = pagoBase({ estado: 'pendiente', fueRechazado: false });
  const detalle = detalleBase({ vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, pago });
  const dom = await bootPanel({
    htmlFile: 'panel-vendedor.html', jsFile: 'panel-vendedor.js', identity: IDENTIDAD_VENDEDOR, ventas: [venta],
    extraRoutes: {
      '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
      '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
    },
  });
  const body = await abrirFicha(dom, 'venta-1');
  assert.equal(body.querySelector('form[data-subir-comprobante]'), null, 'no corresponde subir comprobante antes de informar el pago: ' + body.textContent);
  assert.ok(body.querySelector('form[data-informar-pago]'), 'debe poder informar el pago: ' + body.textContent);
});

test('Panel Vendedor — pago "pendiente" y rechazado: la corrección sigue disponible (informar de nuevo, con el motivo visible)', async () => {
  const venta = ventaBase({ codigoVenta: 'V-RECHAZADO' });
  const pago = pagoBase({ estado: 'pendiente', fueRechazado: true });
  const detalle = detalleBase({ vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, pago });
  const dom = await bootPanel({
    htmlFile: 'panel-vendedor.html', jsFile: 'panel-vendedor.js', identity: IDENTIDAD_VENDEDOR, ventas: [venta],
    extraRoutes: {
      '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
      '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      '/interno/api/ventas/venta-1/pagos/pago-1/comprobante': comprobanteRoute({ id: 'c1', version: 1, nombreOriginal: 'viejo.pdf', rechazadoEn: '2026-09-18 00:00:00', motivoRechazo: 'Monto ilegible' }),
    },
  });
  const body = await abrirFicha(dom, 'venta-1');
  assert.ok(body.textContent.includes('Comprobante rechazado'), 'el motivo del rechazo debe seguir visible: ' + body.textContent);
  assert.ok(body.textContent.includes('Monto ilegible'), 'el motivo específico debe seguir visible: ' + body.textContent);
  assert.ok(body.querySelector('form[data-informar-pago]'), 'la corrección sigue disponible (informar de nuevo): ' + body.textContent);
});

test('Panel Vendedor — pago "informado" (antes de acreditar): el selector de archivo y "Subir corrección" siguen disponibles', async () => {
  const venta = ventaBase({ codigoVenta: 'V-INFORMADO' });
  const pago = pagoBase({ estado: 'informado' });
  const detalle = detalleBase({ vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, pago });
  const dom = await bootPanel({
    htmlFile: 'panel-vendedor.html', jsFile: 'panel-vendedor.js', identity: IDENTIDAD_VENDEDOR, ventas: [venta],
    extraRoutes: {
      '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
      '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      '/interno/api/ventas/venta-1/pagos/pago-1/comprobante': comprobanteRoute({ id: 'c1', version: 1, nombreOriginal: 'comprobante.pdf', rechazadoEn: null, motivoRechazo: null }),
    },
  });
  const body = await abrirFicha(dom, 'venta-1');
  const form = body.querySelector('form[data-subir-comprobante]');
  assert.ok(form, 'debe poder subir una corrección mientras está informado, sin acreditar: ' + body.textContent);
  assert.ok(form.querySelector('input[type="file"]'), 'debe tener selector de archivo: ' + body.textContent);
  assert.ok(body.textContent.includes('Subir corrección'), 'el botón debe ofrecer "Subir corrección" (ya hay un comprobante subido): ' + body.textContent);
});

test('Panel Vendedor — pago "acreditado": NO hay selector de archivo ni "Subir corrección", pero el comprobante validado sigue visible', async () => {
  const venta = ventaBase({ codigoVenta: 'V-ACREDITADO' });
  const pago = pagoBase({ estado: 'acreditado' });
  const detalle = detalleBase({ vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, pago });
  const dom = await bootPanel({
    htmlFile: 'panel-vendedor.html', jsFile: 'panel-vendedor.js', identity: IDENTIDAD_VENDEDOR, ventas: [venta],
    extraRoutes: {
      '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
      '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      '/interno/api/ventas/venta-1/pagos/pago-1/comprobante': comprobanteRoute({ id: 'c1', version: 2, nombreOriginal: 'comprobante-final.pdf', rechazadoEn: null, motivoRechazo: null }),
    },
  });
  const body = await abrirFicha(dom, 'venta-1');
  assert.equal(body.querySelector('form[data-subir-comprobante]'), null, 'no debe existir ningún formulario de carga: ' + body.textContent);
  assert.equal(body.querySelector('input[type="file"]'), null, 'no debe existir ningún selector de archivo: ' + body.textContent);
  assert.ok(!body.textContent.includes('Subir corrección'), 'no debe ofrecerse "Subir corrección": ' + body.textContent);
  assert.ok(!body.textContent.includes('Subir comprobante'), 'no debe ofrecerse "Subir comprobante": ' + body.textContent);
  // El comprobante validado sigue siempre visible.
  assert.ok(body.textContent.includes('comprobante-final.pdf'), 'el comprobante validado debe seguir visible: ' + body.textContent);
  assert.ok(body.textContent.includes('versión 2'), 'la versión del comprobante debe seguir visible: ' + body.textContent);
});

// ── Panel Administrativo ────────────────────────────────────────────────

test('Panel Administrativo — pago "informado" (antes de acreditar): "Acreditar pago" y "Rechazar" siguen disponibles, comprobante visible', async () => {
  const venta = ventaBase({ codigoVenta: 'V-ADMIN-INFORMADO', vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba' });
  const pago = pagoBase({ estado: 'informado' });
  const detalle = detalleBase({ vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, pago });
  const dom = await bootPanel({
    htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
    extraRoutes: {
      '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
      '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      '/interno/api/ventas/venta-1/pagos/pago-1/comprobante': comprobanteRoute({ id: 'c1', version: 1, nombreOriginal: 'comprobante.pdf', rechazadoEn: null, motivoRechazo: null }),
    },
  });
  const body = await abrirFicha(dom, 'venta-1');
  assert.ok(body.querySelector('form[data-acreditar-pago]'), 'debe poder acreditar el pago mientras está solo informado: ' + body.textContent);
  assert.ok(body.querySelector('form[data-rechazar-pago]'), 'debe poder rechazar/pedir comprobante nuevo antes de acreditar: ' + body.textContent);
  // Panel Administrativo muestra "Ver comprobante (versión N)" — nunca el
  // nombre original del archivo (a diferencia de Panel Vendedor).
  assert.ok(body.textContent.includes('Ver comprobante (versión 1)'), 'el comprobante informado debe estar visible: ' + body.textContent);
  // RIO-122 (22/09/2026, hallazgo de UAT): el link funcionaba pero no se
  // veía como acción — debe vivir dentro de .pv-comprobante-link (el mismo
  // patrón ya existente en Panel Administrativo, sin CSS aislado nuevo) y
  // conservar exactamente el mismo href/target/rel de siempre.
  const linkComprobante = [...body.querySelectorAll('a')].find((a) => a.textContent === 'Ver comprobante (versión 1)');
  assert.ok(linkComprobante, 'debe existir el link real "Ver comprobante (versión 1)": ' + body.textContent);
  assert.ok(linkComprobante.closest('.pv-comprobante-link'), 'debe reconocerse como acción vía el patrón ya existente pv-comprobante-link');
  assert.equal(linkComprobante.getAttribute('href'), '/interno/api/ventas/venta-1/pagos/pago-1/comprobante/c1/archivo', 'el href no debe cambiar con esta corrección de presentación');
  assert.equal(linkComprobante.getAttribute('target'), '_blank');
  assert.equal(linkComprobante.getAttribute('rel'), 'noopener');
});

test('Panel Administrativo — pago "acreditado": ni "Acreditar pago" ni "Rechazar" siguen disponibles (RIO-122, hallazgo de UAT), comprobante validado sigue visible', async () => {
  const venta = ventaBase({ codigoVenta: 'V-ADMIN-ACREDITADO', vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba' });
  const pago = pagoBase({ estado: 'acreditado' });
  const detalle = detalleBase({ vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, pago });
  const dom = await bootPanel({
    htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
    extraRoutes: {
      '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
      '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      '/interno/api/ventas/venta-1/pagos/pago-1/comprobante': comprobanteRoute({ id: 'c1', version: 1, nombreOriginal: 'comprobante-final.pdf', rechazadoEn: null, motivoRechazo: null }),
    },
  });
  const body = await abrirFicha(dom, 'venta-1');
  // RIO-122 (22/09/2026): antes de esta corrección, "Acreditar pago" seguía
  // renderizándose acá aunque el backend (acreditarPago) ya rechazara una
  // segunda acreditación — defecto puramente de presentación, nunca de datos.
  assert.equal(body.querySelector('form[data-acreditar-pago]'), null, 'no debe poder volver a acreditar un pago ya acreditado: ' + body.textContent);
  assert.equal(body.querySelector('form[data-rechazar-pago]'), null, 'no debe poder rechazar un pago ya acreditado: ' + body.textContent);
  assert.ok(body.textContent.includes('Ver comprobante (versión 1)'), 'el comprobante validado debe seguir visible: ' + body.textContent);
});

test('Panel Administrativo — detalle de Liquidaciones: el link "Ver" del comprobante de transferencia se reconoce como acción (RIO-122, hallazgo de UAT)', async () => {
  const venta = ventaBase({ codigoVenta: 'V-ADMIN-LIQ' });
  const dom = await bootPanel({
    htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
    extraRoutes: {
      '/interno/api/comisiones': () => ({ ok: true, data: { comisiones: [] } }),
      '/interno/api/comisiones/liquidaciones': () => ({ ok: true, data: { liquidaciones: [{ id: 'liq-1', beneficiarioEmail: 'brenda@rioimpulsodigital.com', montoTotalTransferido: 48000, monedaFinal: 'ARS', fecha: '2026-09-21' }] } }),
      '/interno/api/comisiones/liquidaciones/liq-1': () => ({ ok: true, data: { liquidacion: { beneficiarioEmail: 'brenda@rioimpulsodigital.com', fecha: '2026-09-21', montoTotalTransferido: 48000, monedaFinal: 'ARS', comprobanteNota: null }, detalle: [] } }),
      '/interno/api/comisiones/liquidaciones/liq-1/estado-documental': () => ({ ok: true, data: { estadoDocumental: 'documentacion_completa' } }),
      '/interno/api/comisiones/liquidaciones/liq-1/comprobante-transferencia': () => ({ ok: true, data: { comprobante: { id: 'comp-1', version: 1, nombreOriginal: 'comprobante.pdf', rechazadoEn: null, motivoRechazo: null } } }),
    },
  });
  dom.window.document.getElementById('pvTabLiquidacionesBtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush(20);
  dom.window.document.querySelector('[data-ver-liquidacion="liq-1"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush(20);

  const slot = dom.window.document.getElementById('pvLiqDetalle-liq-1');
  const link = [...slot.querySelectorAll('a')].find((a) => a.textContent === 'Ver');
  assert.ok(link, 'debe existir el link real "Ver": ' + slot.innerHTML);
  assert.ok(link.closest('.pv-comprobante-link'), 'debe reutilizar el mismo patrón pv-comprobante-link, sin CSS aislado nuevo');
  assert.equal(link.getAttribute('href'), '/interno/api/comisiones/liquidaciones/liq-1/comprobante-transferencia/comp-1/archivo', 'el href no debe cambiar con esta corrección de presentación');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener');
});
