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
//
// Ajuste 14/09/2026: Brenda confirmó que el texto largo ("... —
// pendiente de validación" / "... — requiere corrección") se salía de
// la columna de la tabla — se acortó a "Pago informado"/"Pago
// rechazado" en interno/config/estado-pago.js. El detalle de cada pago
// sigue mostrando el contexto completo (motivo del rechazo incluido);
// estas pruebas se actualizaron para reflejar el texto corto vigente.

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

  test(`Panel ${panel.nombre} — tabla: pago informado se muestra como "Pago informado" (caso UAT Peluquería Canina; texto acortado a pedido de Brenda — el largo se salía de la columna)`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-20260903-967F6E', cliente: { negocio: 'Peluquería Canina' }, estadoPagoResumen: 'informado' });
    const dom = await bootPanel({ ...panel, ventas: [venta] });
    const texto = filaTexto(dom, 'V-20260903-967F6E');
    assert.ok(texto, 'la fila debe existir en la tabla');
    assert.ok(texto.includes('Pago informado'), 'texto real de la fila: ' + texto);
    assert.ok(!texto.includes('En espera de pago'), 'la tabla no debe contradecir el detalle (que ya muestra informado)');
  });

  test(`Panel ${panel.nombre} — tabla: pago rechazado se muestra como "Pago rechazado"`, async () => {
    const venta = ventaBase({ codigoVenta: 'V-RECHAZADO', estadoPagoResumen: 'rechazado' });
    const dom = await bootPanel({ ...panel, ventas: [venta] });
    const texto = filaTexto(dom, 'V-RECHAZADO');
    assert.ok(texto.includes('Pago rechazado'), 'texto real de la fila: ' + texto);
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
    assert.ok(textoTabla.includes('Pago informado'), 'tabla real: ' + textoTabla);
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

  // ── RIO-122 (corrección de causa raíz, 15/09/2026): la ficha no
  // exponía ningún "Estado operativo/producción" propio — un venta con el
  // componente ya en producción y el pago ya acreditado mostraba
  // "Registrado" al abrir el detalle mientras la tabla, para la MISMA
  // venta, ya mostraba "En producción". Estas pruebas abren la ficha real
  // (click en la fila, igual que un usuario) y leen el texto
  // efectivamente renderizado — no alcanza con probar la respuesta de la
  // API (ver mismo criterio ya aplicado arriba para la tabla). ──────────
  test(`Panel ${panel.nombre} — ficha: caso de referencia (operativo EN PRODUCCIÓN + pago ACREDITADO) muestra "Estado operativo / producción: En producción", coherente con la tabla`, async () => {
    const venta = ventaBase({
      id: 'venta-1', codigoVenta: 'V-20260903-967F6E', cliente: { negocio: 'Peluquería Canina' },
      estadoOperativo: 'en_produccion', estadoPagoResumen: 'acreditado',
    });
    const detalle = {
      venta: {
        id: 'venta-1', codigoVenta: venta.codigoVenta, mercado: 'CL', producto: 'ficha', moneda: 'CLP',
        precioPactado: 60000, vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre,
        estadoActual: 'registrada', estadoOperativo: 'en_produccion', estadoPagoResumen: 'acreditado',
        createdAt: '2026-09-13 00:00:00', tipoVenta: 'equipo', equipoId: null, equipoNombre: null,
        supervisorEmail: null, supervisorNombre: null, supervisionAplica: false, motivoSinSupervision: null,
        porcentajeSupervisionAplicado: 0, nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
        distribucionSnapshot: null, modoHistorico: null, proximaAccion: null, responsableProximaAccion: null,
        antecedentesKit: null,
      },
      cliente: { id: 'cliente-1', negocio: 'Peluquería Canina', contactoNombre: null, telefono: null, email: null, datosFacturacionAr: null },
      proyecto: { id: 'proyecto-1', codigoProyecto: 'P-20260903-C6AC87', estadoActual: 'en_produccion' },
      componentes: [],
      pagosEsperados: [{ id: 'pago-1', tipo: 'total', etiqueta: null, monto: 60000, moneda: 'CLP', estado: 'acreditado', hitoValidado: false, hitoValidadoPor: null, hitoValidadoAt: null, hitoNota: null, fueRechazado: false }],
    };
    const dom = await bootPanel({
      ...panel, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-1': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-1/pagos/pago-1/comprobante': () => ({ ok: true, data: { comprobante: null } }),
        '/interno/api/ventas/venta-1/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });

    // 1) Tabla — mismo criterio que ya prueban las pruebas de arriba.
    const textoTabla = filaTexto(dom, 'V-20260903-967F6E');
    assert.ok(textoTabla.includes('En producción'), 'tabla real: ' + textoTabla);

    // 2) Ficha — abrir el detalle con un click real en la fila, como haría
    // Brenda, y leer el texto efectivamente renderizado.
    const tr = [...dom.window.document.querySelectorAll('#pvVentasResult tbody tr')].find((r) => r.getAttribute('data-venta-id') === 'venta-1');
    assert.ok(tr, 'la fila de la venta de referencia debe existir');
    tr.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await flush();
    const textoFicha = dom.window.document.getElementById('pvDetailBody').textContent;
    assert.ok(textoFicha.includes('Estado operativo / producción'), 'la ficha debe exponer el campo, separado del estado de pago: ' + textoFicha);
    assert.ok(textoFicha.includes('En producción'), 'ficha real: ' + textoFicha);
    assert.ok(!textoFicha.includes('Registrado'), 'antes de esta corrección, la ficha quedaba mostrando "Registrado" pese a que la tabla ya avanzó');

    // 3) Estado de pago sigue visible, SEPARADO, en la sección de Pagos
    // (por-pago, ya existente) — nunca fusionado en el mismo campo.
    assert.ok(textoFicha.includes('Acreditado'), 'el estado de pago debe seguir visible en su propia sección: ' + textoFicha);
  });

  test(`Panel ${panel.nombre} — ficha: una venta recién registrada (sin pago acreditado) muestra "En espera de pago", igual que la tabla`, async () => {
    const venta = ventaBase({ id: 'venta-2', codigoVenta: 'V-NUEVA', estadoOperativo: 'en_espera_pago', estadoPagoResumen: 'pendiente' });
    const detalle = {
      venta: {
        id: 'venta-2', codigoVenta: 'V-NUEVA', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
        precioPactado: 60000, vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre,
        estadoActual: 'registrada', estadoOperativo: 'en_espera_pago', estadoPagoResumen: 'pendiente',
        createdAt: '2026-09-13 00:00:00', tipoVenta: 'equipo', equipoId: null, equipoNombre: null,
        supervisorEmail: null, supervisorNombre: null, supervisionAplica: false, motivoSinSupervision: null,
        porcentajeSupervisionAplicado: 0, nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
        distribucionSnapshot: null, modoHistorico: null, proximaAccion: null, responsableProximaAccion: null,
        antecedentesKit: null,
      },
      cliente: { id: 'cliente-2', negocio: 'Peluquería Canina', contactoNombre: null, telefono: null, email: null, datosFacturacionAr: null },
      proyecto: { id: 'proyecto-2', codigoProyecto: 'P-2', estadoActual: 'registrado' },
      componentes: [],
      pagosEsperados: [{ id: 'pago-2', tipo: 'total', etiqueta: null, monto: 60000, moneda: 'CLP', estado: 'pendiente', hitoValidado: false, hitoValidadoPor: null, hitoValidadoAt: null, hitoNota: null, fueRechazado: false }],
    };
    const dom = await bootPanel({
      ...panel, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-2': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-2/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });

    const tr = [...dom.window.document.querySelectorAll('#pvVentasResult tbody tr')].find((r) => r.getAttribute('data-venta-id') === 'venta-2');
    tr.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await flush();
    const textoFicha = dom.window.document.getElementById('pvDetailBody').textContent;
    assert.ok(textoFicha.includes('En espera de pago'), 'una venta sin comprobante debe seguir mostrando "En espera de pago" en la ficha: ' + textoFicha);
    assert.ok(!textoFicha.includes('En producción'), 'sin avance real, nunca debe mostrarse un estado operativo más avanzado');
  });

  // ── RIO-122 (UAT Negocio Test 14B, hallazgo 8, 15/09/2026): entrega
  // terminada esperando aprobación del cliente — antes seguía mostrando
  // "En producción", información engañosa sobre quién tiene la pelota. ──
  test(`Panel ${panel.nombre} — tabla y ficha: componente entregado, esperando aprobación del cliente, muestra "Espera aprobación" (nunca "En producción")`, async () => {
    const venta = ventaBase({ id: 'venta-3', codigoVenta: 'V-ESPERA-APROBACION', estadoOperativo: 'en_espera_aprobacion', estadoPagoResumen: 'acreditado' });
    const detalle = {
      venta: {
        id: 'venta-3', codigoVenta: 'V-ESPERA-APROBACION', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
        precioPactado: 60000, vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre,
        estadoActual: 'registrada', estadoOperativo: 'en_espera_aprobacion', estadoPagoResumen: 'acreditado',
        createdAt: '2026-09-15 00:00:00', tipoVenta: 'equipo', equipoId: null, equipoNombre: null,
        supervisorEmail: null, supervisorNombre: null, supervisionAplica: false, motivoSinSupervision: null,
        porcentajeSupervisionAplicado: 0, nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
        distribucionSnapshot: null, modoHistorico: null, proximaAccion: null, responsableProximaAccion: null,
        antecedentesKit: null,
      },
      cliente: { id: 'cliente-3', negocio: 'Peluquería Canina', contactoNombre: null, telefono: null, email: null, datosFacturacionAr: null },
      proyecto: { id: 'proyecto-3', codigoProyecto: 'P-3', estadoActual: 'en_espera_aprobacion' },
      componentes: [{ id: 'comp-3', tipo: 'landing', nombre: null, descripcion: null, precioIndividualReferencia: 60000, precioAtribuido: 60000, estadoActual: 'entregada', materialesEstado: 'completos', orden: null, responsableOperativoEmail: null, fechaPrevista: null, fechaReal: null, materialesInformes: [], materialesConfirmaciones: [], costoDominioPendiente: false }],
      pagosEsperados: [{ id: 'pago-3', tipo: 'total', etiqueta: null, monto: 60000, moneda: 'CLP', estado: 'acreditado', hitoValidado: false, hitoValidadoPor: null, hitoValidadoAt: null, hitoNota: null, fueRechazado: false }],
    };
    const dom = await bootPanel({
      ...panel, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-3': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-3/pagos/pago-3/comprobante': () => ({ ok: true, data: { comprobante: null } }),
        '/interno/api/ventas/venta-3/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });

    const textoTabla = filaTexto(dom, 'V-ESPERA-APROBACION');
    assert.ok(textoTabla.includes('Espera aprobación'), 'tabla real: ' + textoTabla);
    assert.ok(!textoTabla.includes('En producción'));

    const tr = [...dom.window.document.querySelectorAll('#pvVentasResult tbody tr')].find((r) => r.getAttribute('data-venta-id') === 'venta-3');
    tr.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await flush();
    const textoFicha = dom.window.document.getElementById('pvDetailBody').textContent;
    assert.ok(textoFicha.includes('Espera aprobación'), 'ficha real: ' + textoFicha);
    assert.ok(!textoFicha.includes('En producción'), 'antes de esta corrección, la ficha (y la tabla) seguían mostrando "En producción" mientras se esperaba al cliente');
  });

  test(`Panel ${panel.nombre} — tabla y ficha: todos los componentes aprobados pero la comisión todavía no está pagada muestra "Pendiente cierre" (nunca "Completado" antes de tiempo)`, async () => {
    const venta = ventaBase({ id: 'venta-4', codigoVenta: 'V-PENDIENTE-CIERRE', estadoOperativo: 'pendiente_cierre', estadoPagoResumen: 'acreditado' });
    const detalle = {
      venta: {
        id: 'venta-4', codigoVenta: 'V-PENDIENTE-CIERRE', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
        precioPactado: 60000, vendedorEmail: venta.vendedorEmail, vendedorNombre: venta.vendedorNombre,
        estadoActual: 'registrada', estadoOperativo: 'pendiente_cierre', estadoPagoResumen: 'acreditado',
        createdAt: '2026-09-15 00:00:00', tipoVenta: 'equipo', equipoId: null, equipoNombre: null,
        supervisorEmail: null, supervisorNombre: null, supervisionAplica: false, motivoSinSupervision: null,
        porcentajeSupervisionAplicado: 0, nombreProyecto: null, descripcionProyecto: null, notionUrl: null,
        distribucionSnapshot: null, modoHistorico: null, proximaAccion: null, responsableProximaAccion: null,
        antecedentesKit: null,
      },
      cliente: { id: 'cliente-4', negocio: 'Peluquería Canina', contactoNombre: null, telefono: null, email: null, datosFacturacionAr: null },
      proyecto: { id: 'proyecto-4', codigoProyecto: 'P-4', estadoActual: 'pendiente_cierre' },
      componentes: [{ id: 'comp-4', tipo: 'landing', nombre: null, descripcion: null, precioIndividualReferencia: 60000, precioAtribuido: 60000, estadoActual: 'aprobada', materialesEstado: 'completos', orden: null, responsableOperativoEmail: null, fechaPrevista: null, fechaReal: null, materialesInformes: [], materialesConfirmaciones: [], costoDominioPendiente: false }],
      pagosEsperados: [{ id: 'pago-4', tipo: 'total', etiqueta: null, monto: 60000, moneda: 'CLP', estado: 'acreditado', hitoValidado: false, hitoValidadoPor: null, hitoValidadoAt: null, hitoNota: null, fueRechazado: false }],
    };
    const dom = await bootPanel({
      ...panel, ventas: [venta],
      extraRoutes: {
        '/interno/api/ventas/venta-4': () => ({ ok: true, data: detalle }),
        '/interno/api/ventas/venta-4/pagos/pago-4/comprobante': () => ({ ok: true, data: { comprobante: null } }),
        '/interno/api/ventas/venta-4/historial': () => ({ ok: true, data: { eventos: [] } }),
      },
    });

    const textoTabla = filaTexto(dom, 'V-PENDIENTE-CIERRE');
    assert.ok(textoTabla.includes('Pendiente cierre'), 'tabla real: ' + textoTabla);
    assert.ok(!textoTabla.includes('Completado'));

    const tr = [...dom.window.document.querySelectorAll('#pvVentasResult tbody tr')].find((r) => r.getAttribute('data-venta-id') === 'venta-4');
    tr.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await flush();
    const textoFicha = dom.window.document.getElementById('pvDetailBody').textContent;
    assert.ok(textoFicha.includes('Pendiente cierre'), 'ficha real: ' + textoFicha);
    assert.ok(!textoFicha.includes('Completado'), 'antes de tiempo, la venta nunca debe mostrarse "Completado" con una comisión real sin pagar');
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
    assert.ok(filaTexto(dom, 'V-2').includes('Pago informado'));
    assert.ok(filaTexto(dom, 'V-3').includes('Pago rechazado'));
  });
}
