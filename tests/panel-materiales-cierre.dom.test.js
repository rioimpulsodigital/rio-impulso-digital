// Pruebas de DOM real (jsdom) — RIO-122 (17/09/2026), cierre operativo de
// la etapa de materiales. Brenda reportó que, aunque un componente ya
// hubiera entrado en producción (o incluso hubiera sido aprobado), el
// Portal seguía mostrando controles de edición de materiales: el
// formulario "Informar nuevos materiales" (Vendedor) y el formulario
// "Resultado de esta entrega" / "Guardar revisión" (Administrativo) —
// ambos pensados exclusivamente para la etapa PREVIA a producción.
//
// Regla: la etapa de materiales queda abierta mientras
// `componente.estadoActual` sea 'bloqueada' o 'pendiente' — desde
// 'en_produccion' en adelante (en_produccion / entregada / aprobada) se
// cierra para nuevas entregas y revisiones, pero el HISTORIAL de entregas
// (quién entregó, qué entregó, fecha y resultado) sigue siempre visible,
// nunca se borra ni se oculta. Esta suite abre la ficha real de cada
// panel (click en la fila, como haría un usuario) y lee el DOM
// efectivamente renderizado — mismo criterio que
// tests/panel-estado-pago.dom.test.js, nunca se reimplementa la lógica
// del panel acá.
//
// Nota: Vendedor cierra su formulario "Informar nuevos materiales" acá
// también, a pedido explícito de Brenda — reemplaza la regla anterior de
// RIO-118 ("la posibilidad de informar materiales debe permanecer
// siempre abierta"). Panel Supervisor es de solo lectura para materiales
// desde su diseño original (RIO-118) — nunca mostró estos controles, no
// necesita ningún cambio ni prueba nueva acá.

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
    mercado: 'CL', producto: 'ficha', moneda: 'CLP', tipoPrecio: 'lanzamiento', precioPactado: 60000,
    vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba',
    equipoId: null, equipoNombre: null, supervisorNombre: null,
    tipoVenta: 'equipo', supervisionAplica: false, motivoSinSupervision: null,
    estadoActual: 'registrada', proyectoEstado: 'en_produccion',
    estadoOperativo: 'en_produccion', estadoPagoResumen: 'acreditado', estadoMaterialesResumen: 'informados',
    origen: 'kit_comercial', esDemo: false,
    nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
    distribucionSnapshot: null, modoHistorico: null,
    createdAt: '2026-09-17 00:00:00',
  }, overrides);
}

function detalleBase({ ventaId, codigoVenta, vendedorEmail, vendedorNombre, componente }) {
  return {
    venta: {
      id: ventaId, codigoVenta, mercado: 'CL', producto: 'ficha', moneda: 'CLP',
      precioPactado: 60000, vendedorEmail, vendedorNombre,
      estadoActual: 'registrada', estadoOperativo: componente.estadoActual === 'aprobada' ? 'completado' : 'en_produccion',
      estadoPagoResumen: 'acreditado',
      createdAt: '2026-09-17 00:00:00', tipoVenta: 'equipo', equipoId: null, equipoNombre: null,
      supervisorEmail: null, supervisorNombre: null, supervisionAplica: false, motivoSinSupervision: null,
      porcentajeSupervisionAplicado: 0, nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
      distribucionSnapshot: null, modoHistorico: null, proximaAccion: null, responsableProximaAccion: null,
      antecedentesKit: null,
    },
    cliente: { id: 'cliente-1', negocio: 'Peluquería Canina', contactoNombre: null, telefono: null, email: null, datosFacturacionAr: null },
    proyecto: { id: 'proyecto-1', codigoProyecto: 'P-1', estadoActual: componente.estadoActual },
    componentes: [componente],
    pagosEsperados: [],
  };
}

function componenteConEntrega(estadoActual, overrides) {
  return Object.assign({
    id: 'comp-1', tipo: 'ficha', nombre: null, descripcion: null,
    precioIndividualReferencia: 60000, precioAtribuido: 60000,
    estadoActual, materialesEstado: 'informados', orden: null,
    responsableOperativoEmail: null, fechaPrevista: null, fechaReal: null,
    materialesInformes: [{
      id: 'entrega-1', numeroEntrega: 1, estadoRevision: 'informada',
      informadoPorNombre: 'Vendedor de Prueba', createdAt: '2026-09-17 00:00:00',
      elementos: ['logo', 'fotos'], cantidadArchivosAprox: 5,
      descripcion: 'Logo y fotos del local', observaciones: null,
      motivoRevision: null, revisadoPorNombre: null, revisadoEn: null,
    }],
    materialesConfirmaciones: [], costoDominioPendiente: false,
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

// ── Panel Vendedor — "Informar nuevos materiales" ──────────────────────

const ANTES_PRODUCCION = ['bloqueada', 'pendiente'];
const DESDE_PRODUCCION = ['en_produccion', 'entregada', 'aprobada'];

for (const estado of ANTES_PRODUCCION) {
  test(`Panel Vendedor — componente '${estado}' (antes de producción): el formulario "Informar nuevos materiales" sigue disponible`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-ANTES' });
    const componente = componenteConEntrega(estado, { materialesInformes: [] });
    const detalle = detalleBase({ ventaId: 'venta-1', codigoVenta: 'V-ANTES', vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, componente });
    const dom = await bootPanel({
      htmlFile: 'panel-vendedor.html', jsFile: 'panel-vendedor.js', identity: IDENTIDAD_VENDEDOR, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });
    const body = await abrirFicha(dom, 'venta-1');
    assert.ok(body.querySelector('form[data-informar-materiales]'), `debe existir el formulario con estadoActual='${estado}': ` + body.textContent);
  });
}

for (const estado of DESDE_PRODUCCION) {
  test(`Panel Vendedor — componente '${estado}' (producción o después): el formulario "Informar nuevos materiales" ya NO está, pero el historial de entregas sigue visible`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-CERRADO-' + estado });
    const componente = componenteConEntrega(estado);
    const detalle = detalleBase({ ventaId: 'venta-1', codigoVenta: venta.codigoVenta, vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, componente });
    const dom = await bootPanel({
      htmlFile: 'panel-vendedor.html', jsFile: 'panel-vendedor.js', identity: IDENTIDAD_VENDEDOR, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });
    const body = await abrirFicha(dom, 'venta-1');
    assert.equal(body.querySelector('form[data-informar-materiales]'), null, `el formulario NO debe existir con estadoActual='${estado}': ` + body.textContent);
    // El historial (quién entregó, qué entregó, fecha) sigue siempre visible.
    assert.ok(body.textContent.includes('Entrega N.º 1'), 'el historial de la entrega debe seguir visible: ' + body.textContent);
    assert.ok(body.textContent.includes('Vendedor de Prueba'), 'quién entregó debe seguir visible: ' + body.textContent);
    assert.ok(body.textContent.includes('Logo y fotos del local'), 'qué se entregó debe seguir visible: ' + body.textContent);
  });
}

// ── Panel Administrativo — "Resultado de esta entrega" / "Guardar revisión" ──

for (const estado of ANTES_PRODUCCION) {
  test(`Panel Administrativo — componente '${estado}' (antes de producción): "Resultado de esta entrega" sigue disponible`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-ADMIN-ANTES', vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba' });
    const componente = componenteConEntrega(estado);
    const detalle = detalleBase({ ventaId: 'venta-1', codigoVenta: 'V-ADMIN-ANTES', vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, componente });
    const dom = await bootPanel({
      htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });
    const body = await abrirFicha(dom, 'venta-1');
    assert.ok(body.querySelector('form[data-revisar-entrega]'), `debe existir "Resultado de esta entrega" con estadoActual='${estado}': ` + body.textContent);
  });
}

for (const estado of DESDE_PRODUCCION) {
  test(`Panel Administrativo — componente '${estado}' (producción o después): "Resultado de esta entrega" ya NO está, pero el historial sigue visible`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-ADMIN-CERRADO-' + estado, vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba' });
    const componente = componenteConEntrega(estado, {
      materialesInformes: [{
        id: 'entrega-1', numeroEntrega: 1, estadoRevision: 'aceptada',
        informadoPorNombre: 'Vendedor de Prueba', createdAt: '2026-09-17 00:00:00',
        elementos: ['logo', 'fotos'], cantidadArchivosAprox: 5,
        descripcion: 'Logo y fotos del local', observaciones: null,
        motivoRevision: null, revisadoPorNombre: 'Admin de Prueba', revisadoEn: '2026-09-17 01:00:00',
      }],
    });
    const detalle = detalleBase({ ventaId: 'venta-1', codigoVenta: venta.codigoVenta, vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, componente });
    const dom = await bootPanel({
      htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });
    const body = await abrirFicha(dom, 'venta-1');
    assert.equal(body.querySelector('form[data-revisar-entrega]'), null, `"Resultado de esta entrega" NO debe existir con estadoActual='${estado}': ` + body.textContent);
    assert.equal(body.querySelector('button[data-accion-componente="materiales-completos"]'), null, '"Marcar materiales completos" tampoco debe existir: ' + body.textContent);
    // Historial completo (quién entregó, qué entregó, fecha, resultado) sigue visible.
    assert.ok(body.textContent.includes('Entrega N.º 1'), 'el historial de la entrega debe seguir visible: ' + body.textContent);
    assert.ok(body.textContent.includes('Vendedor de Prueba'), 'quién entregó debe seguir visible: ' + body.textContent);
    assert.ok(body.textContent.includes('Logo y fotos del local'), 'qué se entregó debe seguir visible: ' + body.textContent);
    assert.ok(body.textContent.includes('Aceptada'), 'el resultado final de la revisión debe seguir visible: ' + body.textContent);
    assert.ok(body.textContent.includes('Admin de Prueba'), 'quién revisó debe seguir visible: ' + body.textContent);
  });
}

test('Panel Administrativo — "Marcar materiales completos" sigue disponible antes de producción, sin ninguna entrega informada todavía', async () => {
  const venta = ventaBase({ codigoVenta: 'V-SIN-ENTREGAS', vendedorEmail: 'vendedor@example.com', vendedorNombre: 'Vendedor de Prueba' });
  const componente = componenteConEntrega('pendiente', { materialesInformes: [], materialesEstado: 'pendiente' });
  const detalle = detalleBase({ ventaId: 'venta-1', codigoVenta: 'V-SIN-ENTREGAS', vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre, componente });
  const dom = await bootPanel({
    htmlFile: 'panel-administrativo.html', jsFile: 'panel-administrativo.js', identity: IDENTIDAD_ADMIN, ventas: [venta],
    extraRoutes: {
      '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
      '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
    },
  });
  const body = await abrirFicha(dom, 'venta-1');
  assert.ok(body.querySelector('button[data-accion-componente="materiales-completos"]'), 'debe seguir disponible antes de producción, sin entregas: ' + body.textContent);
});
