// Pruebas de DOM real (jsdom) — RIO-122 (22/09/2026), corrección de
// presentación en "Ver liquidación" de Panel Vendedor, encontrada durante
// la UAT E2E real de Liquidaciones (comisión 57a6cba0-e4d1-4908-b677-
// 77b4a18a57f3, venta V-20260916-C6523C).
//
// Dos hallazgos, exclusivamente de interfaz (la lógica de Liquidaciones,
// D1, R2 y permisos no se tocó):
//
// 1. El estado documental llegaba crudo del backend
//    (estadoDocumental: 'documentacion_completa') y se mostraba sin
//    traducir. Se corrige con ESTADO_DOCUMENTAL_LABEL, ahora centralizado
//    en interno/config/estado-documental.js (mismo patrón que ya usa
//    interno/config/estado-pago.js) — antes vivía únicamente dentro de
//    panel-administrativo.js, así que Panel Vendedor nunca tuvo acceso.
//
// 2. Los links "Descargar comprobante de transferencia/conversión"
//    funcionaban (mismo href/target/rel de siempre) pero no se
//    reconocían como acción — heredaban el reset global
//    `a { text-decoration:none; color:inherit; }` de assets/css/main.css.
//    Se corrige reutilizando la clase pv-comision-liq-btn, que ya usa
//    "Ver liquidación" en la misma tarjeta — sin CSS nuevo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESTADO_PAGO_JS = fs.readFileSync(path.join(ROOT, 'interno/config/estado-pago.js'), 'utf8');
const ESTADO_DOCUMENTAL_JS = fs.readFileSync(path.join(ROOT, 'interno/config/estado-documental.js'), 'utf8');
const PANEL_SRC = fs.readFileSync(path.join(ROOT, 'interno/panel-vendedor.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'interno/panel-vendedor.html'), 'utf8');

function flush(ticks = 20) {
  return new Promise((resolve) => {
    let n = 0;
    function tick() { n += 1; if (n >= ticks) resolve(); else setTimeout(tick, 0); }
    tick();
  });
}

async function bootPanel({ identity, ventas, comisionesPorVenta = {}, propias = [], extraRoutes = {} }) {
  const dom = new JSDOM(HTML, {
    url: 'https://rioimpulsodigital.com/interno/panel-vendedor.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const routes = Object.assign({
    '/interno/api/identidad/whoami': () => ({ ok: true, data: identity }),
    '/interno/api/ventas': () => ({ ok: true, data: { ventas } }),
    '/interno/api/identidad/referente': () => ({ ok: true, data: { referentes: [] } }),
    '/interno/api/notificaciones': () => ({ ok: true, data: { notificaciones: [] } }),
    '/interno/api/equipos': () => ({ ok: true, data: { equipos: [] } }),
    // RIO-122: comisiones donde el usuario es beneficiario, sin importar de quién es la venta.
    '/interno/api/comisiones/propias': () => ({ ok: true, data: { comisiones: propias } }),
  }, extraRoutes);
  ventas.forEach((v) => {
    routes['/interno/api/ventas/' + v.id + '/comisiones'] = () => ({ ok: true, data: { comisiones: comisionesPorVenta[v.id] || [] } });
  });

  dom.window.fetch = async (url) => {
    const rutaSinQuery = String(url).split('?')[0];
    const handler = routes[rutaSinQuery];
    if (!handler) throw new Error('ruta no mockeada en el test: ' + url);
    return { ok: true, status: 200, json: async () => handler() };
  };

  // Mismo orden de carga que panel-vendedor.html: estado-pago.js y
  // estado-documental.js ANTES del panel — nunca se reimplementa la
  // traducción de estados acá, se usa el mismo global que ya consume el
  // panel real.
  dom.window.eval(ESTADO_PAGO_JS);
  dom.window.eval(ESTADO_DOCUMENTAL_JS);
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

async function abrirVerLiquidacion(dom, comisionId) {
  const btn = dom.window.document.querySelector('[data-ver-liquidacion="' + comisionId + '"]');
  if (!btn) throw new Error('No se encontró el botón "Ver liquidación" para ' + comisionId + ' — revisar fixture.');
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await flush();
  return dom.window.document.querySelector('[data-liq-info="' + comisionId + '"]');
}

const IDENTIDAD = { email: 'brenda@rioimpulsodigital.com', nombre: 'Brenda', role: 'admin', permissions: { viewOthersData: true } };

function ventaBase(overrides) {
  return Object.assign({
    id: 'venta-1', codigoVenta: 'V-20260916-C6523C', cliente: { negocio: 'Prueba 14' },
    mercado: 'AR', producto: 'generico', moneda: 'ARS', tipoPrecio: 'lanzamiento', precioPactado: 160000,
    vendedorEmail: 'brenda@rioimpulsodigital.com', vendedorNombre: 'Brenda',
    equipoId: null, equipoNombre: null, supervisorNombre: null,
    tipoVenta: 'individual', supervisionAplica: false, motivoSinSupervision: 'sin_equipo',
    estadoActual: 'pendiente_cierre', proyectoEstado: 'pendiente_cierre',
    estadoOperativo: 'pendiente_cierre', estadoPagoResumen: 'acreditado', estadoMaterialesResumen: 'completos',
    origen: 'kit_comercial', esDemo: false,
    nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
    distribucionSnapshot: null, modoHistorico: null,
    createdAt: '2026-09-16 13:19:37',
  }, overrides);
}

function comisionPagadaBase(overrides) {
  return Object.assign({
    id: 'com-liq-1', tipo: 'comercial', componenteId: null,
    beneficiarioEmail: 'brenda@rioimpulsodigital.com', beneficiarioNombre: 'Brenda',
    porcentaje: 30, base: 'utilidad_neta_venta', montoBase: 160000, moneda: 'ARS', montoComision: 48000,
    estado: 'pagada',
    fechaInicioPlazo: '2026-09-16 13:19:37', fechaCumplimientoPlazo: '2026-09-26 13:19:37',
    fechaPagoTotalAcreditado: '2026-09-16 13:19:37', fechaHabilitacion: '2026-09-26 13:19:37',
    fechaProgramadaOriginal: '2026-10-09', fechaProgramadaEfectiva: '2026-10-09',
    fechaPagoReal: '2026-09-21 00:00:00', fechaPrevistaPago: null,
    motivoRetencionOReprogramacion: null, costoDominioPendiente: false,
  }, overrides);
}

const LIQUIDACION_ID = 'liq-1';

function rutasLiquidacion({ comisionId, conversionId = null, comprobanteTransferencia, comprobanteConversion }) {
  const rutas = {
    '/interno/api/comisiones/liquidaciones': () => ({ ok: true, data: { liquidaciones: [{ id: LIQUIDACION_ID }] } }),
    ['/interno/api/comisiones/liquidaciones/' + LIQUIDACION_ID]: () => ({ ok: true, data: { detalle: [{ comisionId, conversionId }] } }),
    ['/interno/api/comisiones/liquidaciones/' + LIQUIDACION_ID + '/estado-documental']: () => ({ ok: true, data: { estadoDocumental: 'documentacion_completa' } }),
    ['/interno/api/comisiones/liquidaciones/' + LIQUIDACION_ID + '/comprobante-transferencia']: () => ({ ok: true, data: { comprobante: comprobanteTransferencia } }),
  };
  if (conversionId) {
    rutas['/interno/api/comisiones/conversiones/' + conversionId + '/comprobante'] = () => ({ ok: true, data: { comprobante: comprobanteConversion } });
  }
  return rutas;
}

test('Panel Vendedor — "Ver liquidación" traduce el estado documental, nunca muestra el enum crudo del backend', async () => {
  const venta = ventaBase({});
  const comision = comisionPagadaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: { 'venta-1': [comision] },
    extraRoutes: rutasLiquidacion({
      comisionId: comision.id,
      comprobanteTransferencia: { id: 'comp-transf-1', version: 1 },
    }),
  });
  await abrirMisComisiones(dom);
  const info = await abrirVerLiquidacion(dom, comision.id);

  assert.ok(info, 'debe existir el slot de info de la liquidación');
  assert.ok(info.innerHTML.includes('Documentación completa'), 'texto real: ' + info.innerHTML);
  assert.ok(!info.innerHTML.includes('documentacion_completa'), 'nunca debe exponerse el enum interno crudo en la interfaz: ' + info.innerHTML);
});

test('Panel Vendedor — Mis comisiones: "Ver liquidación" nunca queda pegado al badge "Pagada" en la misma línea', async () => {
  const venta = ventaBase({});
  // Sin motivoRetencionOReprogramacion ni costoDominioPendiente — son los
  // únicos dos casos que ya forzaban un salto de línea (al ser <div>) antes
  // de esta corrección; sin ellos era exactamente cuando "Ver liquidación"
  // quedaba pegado al badge, como reportó Brenda desde el UAT real.
  const comision = comisionPagadaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: { 'venta-1': [comision] },
  });
  await abrirMisComisiones(dom);
  const celdaEstado = dom.window.document.querySelector('[data-ver-liquidacion="' + comision.id + '"]').closest('td');
  assert.ok(celdaEstado, 'debe existir la celda de Estado de la comisión');
  assert.ok(
    /<\/span><br><button/.test(celdaEstado.innerHTML),
    'debe haber un salto de línea explícito entre el badge y "Ver liquidación": ' + celdaEstado.innerHTML
  );
});

test('Panel Vendedor — "Ver liquidación": los links de descarga (transferencia y conversión) se ven como acción y conservan href/target/rel exactos', async () => {
  const venta = ventaBase({});
  const comision = comisionPagadaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: { 'venta-1': [comision] },
    // Fixture con conversión además de transferencia (caso ARS->CLP) para
    // cubrir los dos links reportados en el mismo bloque, sin duplicar
    // otra suite completa — mismo defecto, mismo origen (RIO-122).
    extraRoutes: rutasLiquidacion({
      comisionId: comision.id,
      conversionId: 'conv-1',
      comprobanteTransferencia: { id: 'comp-transf-1', version: 1 },
      comprobanteConversion: { id: 'comp-conv-1', version: 1 },
    }),
  });
  await abrirMisComisiones(dom);
  const info = await abrirVerLiquidacion(dom, comision.id);

  const linkTransferencia = info.querySelector('a[href*="comprobante-transferencia"]');
  assert.ok(linkTransferencia, '"Descargar comprobante de transferencia" debe seguir siendo un link real: ' + info.innerHTML);
  assert.equal(linkTransferencia.textContent, 'Descargar comprobante de transferencia');
  assert.equal(linkTransferencia.className, 'pv-comision-liq-btn', 'debe reutilizar la misma clase que ya usa "Ver liquidación", sin CSS aislado nuevo');
  assert.equal(
    linkTransferencia.getAttribute('href'),
    '/interno/api/comisiones/liquidaciones/' + LIQUIDACION_ID + '/comprobante-transferencia/comp-transf-1/archivo',
    'el href de descarga no debe cambiar con esta corrección de presentación'
  );
  assert.equal(linkTransferencia.getAttribute('target'), '_blank');
  assert.equal(linkTransferencia.getAttribute('rel'), 'noopener');

  const linkConversion = info.querySelector('a[href*="/conversiones/"]');
  assert.ok(linkConversion, '"Descargar comprobante de conversión" debe seguir siendo un link real: ' + info.innerHTML);
  assert.equal(linkConversion.textContent, 'Descargar comprobante de conversión');
  assert.equal(linkConversion.className, 'pv-comision-liq-btn');
  assert.equal(
    linkConversion.getAttribute('href'),
    '/interno/api/comisiones/conversiones/conv-1/comprobante/comp-conv-1/archivo'
  );
  assert.equal(linkConversion.getAttribute('target'), '_blank');
  assert.equal(linkConversion.getAttribute('rel'), 'noopener');
});

// ── RIO-122 (22/09/2026): "Mis comisiones" incluye las comisiones propias de
// ventas ajenas (GET /comisiones/propias) ─────────────────────────────────
//
// Regla: toda persona beneficiaria legítima de una comisión la ve en "Mis
// comisiones" aunque no sea el vendedor de la venta (realización/practicante,
// participante de un proyecto personalizado, etc.) — sin adquirir acceso a la
// venta ni a datos ajenos (el servidor nunca manda el nombre del cliente).

const IDENTIDAD_PRACTICANTE = { email: 'practicante@example.com', nombre: 'Practicante', role: 'asistente', canSell: false, permissions: { viewOthersData: false } };

function comisionPropiaAjena(overrides) {
  // Forma exacta que devuelve GET /comisiones/propias (sin cliente ni datos de la venta).
  return Object.assign({
    id: 'com-prac-1', tipo: 'realizacion', rolRealizacion: 'practicante', beneficiarioEmail: 'practicante@example.com',
    codigoVenta: 'V-20260901-AAAAAA', producto: 'ficha', mercado: 'CL',
    porcentaje: 10, base: 'utilidad_neta_componente', montoBase: 50000, moneda: 'CLP', montoComision: 5000,
    estado: 'programada', fechaHabilitacion: '2026-09-11 00:00:00',
    fechaProgramadaOriginal: '2026-10-09', fechaProgramadaEfectiva: '2026-10-09', fechaPagoReal: null,
    fechaPrevistaPago: null, motivoRetencionOReprogramacion: null,
  }, overrides);
}

function textoNormalizado(dom) {
  return dom.window.document.getElementById('pvComisionesResult').textContent.replace(/[\s ]+/g, ' ');
}

test('Panel Vendedor — Mis comisiones muestra una comisión propia de una venta AJENA (beneficiario que no vende, sin ventas propias)', async () => {
  const dom = await bootPanel({ identity: IDENTIDAD_PRACTICANTE, ventas: [], propias: [comisionPropiaAjena({})] });
  await abrirMisComisiones(dom);
  const filas = dom.window.document.querySelectorAll('#pvComisionesResult tbody tr');
  assert.equal(filas.length, 1, 'debe listar la comisión propia: ' + textoNormalizado(dom));
  const texto = textoNormalizado(dom);
  assert.ok(texto.includes('V-20260901-AAAAAA'), 'se identifica con el código de la venta: ' + texto);
  assert.ok(texto.includes('Realización'), texto);
  assert.ok(texto.includes('Programada'), texto);
  assert.ok(texto.includes('CLP$ 5.000'), texto);
  // Nunca datos del cliente/negocio: el servidor no los manda y el panel no los inventa.
  assert.ok(!/Peluquer|Nua Bushi|Prueba 14/.test(texto), 'no debe mostrarse el nombre del cliente: ' + texto);
});

test('Panel Vendedor — Mis comisiones NO duplica una comisión cuando la persona es vendedora y beneficiaria a la vez', async () => {
  const venta = ventaBase({});
  const propia = comisionPagadaBase({});
  const ajena = comisionPropiaAjena({ id: 'com-otra-venta', beneficiarioEmail: IDENTIDAD.email });
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: { 'venta-1': [propia] },
    // El servidor devuelve TAMBIÉN la de su propia venta (misma id) más una de una venta ajena.
    propias: [comisionPropiaAjena({ id: propia.id, beneficiarioEmail: IDENTIDAD.email, codigoVenta: venta.codigoVenta, moneda: 'ARS', montoComision: 48000, estado: 'pagada' }), ajena],
  });
  await abrirMisComisiones(dom);
  const html = dom.window.document.getElementById('pvComisionesResult').innerHTML;
  const filas = dom.window.document.querySelectorAll('#pvComisionesResult tbody tr');
  assert.equal(filas.length, 2, 'una fila por comisión, sin duplicar la de la venta propia: ' + textoNormalizado(dom));
  assert.equal((html.match(/data-ver-liquidacion="com-liq-1"/g) || []).length, 1, 'la comisión de la venta propia aparece una sola vez');
  assert.ok(textoNormalizado(dom).includes('Prueba 14'), 'se conserva la versión de "mis ventas", que trae más contexto (cliente)');
});

test('Panel Vendedor — Mis comisiones: los totales por moneda y estado incluyen las comisiones propias de ventas ajenas', async () => {
  const venta = ventaBase({});
  const dom = await bootPanel({
    identity: IDENTIDAD, ventas: [venta],
    comisionesPorVenta: { 'venta-1': [comisionPagadaBase({})] }, // ARS pagada 48.000
    propias: [
      comisionPropiaAjena({ id: 'p-ars', beneficiarioEmail: IDENTIDAD.email, moneda: 'ARS', montoComision: 10000, estado: 'pagada', mercado: 'AR' }),
      comisionPropiaAjena({ id: 'p-clp', beneficiarioEmail: IDENTIDAD.email, moneda: 'CLP', montoComision: 5000, estado: 'programada' }),
    ],
  });
  await abrirMisComisiones(dom);
  const texto = textoNormalizado(dom);
  assert.ok(texto.includes('Pagada: AR$ 58.000'), 'ARS pagada = 48.000 (mis ventas) + 10.000 (venta ajena): ' + texto);
  assert.ok(texto.includes('Programada: CLP$ 5.000'), 'CLP programada de la venta ajena, en su propio bloque de moneda: ' + texto);
  assert.equal(dom.window.document.querySelectorAll('.pv-moneda-block').length, 2, 'nunca se mezclan monedas: un bloque por moneda');
});

test('Panel Vendedor — "Ver liquidación" funciona también para una comisión propia de una venta ajena', async () => {
  const comision = comisionPropiaAjena({ id: 'com-prop-pag', moneda: 'CLP', montoComision: 5000, estado: 'pagada', fechaPagoReal: '2026-09-21 00:00:00' });
  const dom = await bootPanel({
    identity: IDENTIDAD_PRACTICANTE, ventas: [], propias: [comision],
    extraRoutes: rutasLiquidacion({ comisionId: comision.id, comprobanteTransferencia: { id: 'comp-transf-9', version: 1 } }),
  });
  await abrirMisComisiones(dom);
  const info = await abrirVerLiquidacion(dom, comision.id);
  assert.ok(info.innerHTML.includes('Documentación completa'), info.innerHTML);
  const link = info.querySelector('a[href*="comprobante-transferencia"]');
  assert.ok(link, 'el comprobante propio se puede descargar: ' + info.innerHTML);
  assert.equal(link.getAttribute('href'), '/interno/api/comisiones/liquidaciones/liq-1/comprobante-transferencia/comp-transf-9/archivo');
});

test('Panel Vendedor — un vendedor normal conserva el comportamiento vigente (sin comisiones propias extra, o si esa consulta falla) y nunca muestra filas de otro beneficiario', async () => {
  const venta = ventaBase({});
  const base = { identity: IDENTIDAD, ventas: [venta], comisionesPorVenta: { 'venta-1': [comisionPagadaBase({})] } };

  const sinExtras = await bootPanel(base);
  await abrirMisComisiones(sinExtras);
  assert.equal(sinExtras.window.document.querySelectorAll('#pvComisionesResult tbody tr').length, 1);

  const consultaFalla = await bootPanel({ ...base, extraRoutes: { '/interno/api/comisiones/propias': () => { throw new Error('caída de red simulada'); } } });
  await abrirMisComisiones(consultaFalla);
  assert.equal(consultaFalla.window.document.querySelectorAll('#pvComisionesResult tbody tr').length, 1, 'si falla la consulta extra, "Mis comisiones" sigue igual que antes');

  // Defensa en profundidad: aunque el servidor mandara algo de otra persona, el panel no lo muestra.
  const ajeno = await bootPanel({ ...base, propias: [comisionPropiaAjena({ id: 'de-otro', beneficiarioEmail: 'otro@example.com' })] });
  await abrirMisComisiones(ajeno);
  assert.equal(ajeno.window.document.querySelectorAll('#pvComisionesResult tbody tr').length, 1, 'nunca se muestran comisiones de otro beneficiario');
});
