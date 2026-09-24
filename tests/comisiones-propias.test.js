// Pruebas de GET /interno/api/comisiones/propias — RIO-122 (cumplimiento
// funcional de visibilidad de comisiones propias, 22/09/2026).
//
// Regla que debe quedar satisfecha: "Toda persona que sea beneficiaria
// legítima de una comisión puede consultar su propia comisión, aunque no sea
// vendedor_email de la venta, sin adquirir por ello acceso a la venta ni a
// información económica o personal ajena."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as propiasHandler } from '../functions/interno/api/comisiones/propias.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return { email: 'vendedor@example.com', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}

function fakeDb() {
  const state = {
    ventas: [
      // Venta de OTRO vendedor, con datos que jamás deben filtrarse al beneficiario ajeno.
      { id: 'venta-1', codigo_venta: 'V-20260901-AAAAAA', mercado: 'CL', producto: 'ficha', vendedor_email: 'vendedor@example.com', cliente_id: 'cliente-1', precio_pactado: 60000 },
      { id: 'venta-2', codigo_venta: 'V-20260902-BBBBBB', mercado: 'AR', producto: 'proyecto_personalizado', vendedor_email: 'brenda@example.com', cliente_id: 'cliente-2', precio_pactado: 900000 },
    ],
    clientes: [
      { id: 'cliente-1', negocio: 'Peluquería Canina' },
      { id: 'cliente-2', negocio: 'Nua Bushi' },
    ],
    venta_distribuciones: [
      { id: 'dist-vigente', estado: 'confirmada' },
      { id: 'dist-vieja', estado: 'reemplazada' },
    ],
    comisiones: [
      { id: 'com-vendedor', venta_id: 'venta-1', tipo: 'comercial', beneficiario_email: 'vendedor@example.com', moneda: 'CLP', monto_comision: 20000, monto_base: 50000, porcentaje_snapshot: 40, base_snapshot: 'utilidad_neta_venta', estado: 'pagada', fecha_pago_real: '2026-09-21', fecha_inicio_plazo: '2026-09-01 10:00:00', fecha_pago_total_acreditado: '2026-09-01 10:00:00', created_at: '2026-09-01 10:00:00' },
      { id: 'com-supervision', venta_id: 'venta-1', tipo: 'supervision', beneficiario_email: 'alberto@example.com', moneda: 'CLP', monto_comision: 5000, monto_base: 50000, porcentaje_snapshot: 10, base_snapshot: 'utilidad_neta_venta', estado: 'programada', fecha_programada_original: '2026-10-09', fecha_programada_efectiva: '2026-10-09', created_at: '2026-09-01 10:00:00' },
      { id: 'com-practicante', venta_id: 'venta-1', tipo: 'realizacion', rol_realizacion: 'practicante', beneficiario_email: 'practicante@example.com', moneda: 'CLP', monto_comision: 5000, monto_base: 50000, porcentaje_snapshot: 10, base_snapshot: 'utilidad_neta_componente', estado: 'programada', fecha_habilitacion: '2026-09-11 00:00:00', fecha_programada_original: '2026-10-09', fecha_programada_efectiva: '2026-10-09', motivo_retencion_o_reprogramacion: null, created_at: '2026-09-01 10:00:00' },
      { id: 'com-responsable', venta_id: 'venta-1', tipo: 'realizacion', rol_realizacion: 'responsable', beneficiario_email: 'responsable@example.com', moneda: 'CLP', monto_comision: 10000, monto_base: 50000, porcentaje_snapshot: 20, base_snapshot: 'utilidad_neta_componente', estado: 'habilitada', created_at: '2026-09-01 10:00:00' },
      // Participante de un proyecto personalizado (venta de Brenda, ARS).
      { id: 'com-desarrollo', venta_id: 'venta-2', tipo: 'desarrollo', beneficiario_email: 'dev@example.com', distribucion_id: 'dist-vigente', moneda: 'ARS', monto_comision: 300000, monto_base: 700000, porcentaje_snapshot: 45, base_snapshot: 'utilidad_neta_venta', estado: 'calculada_provisional', created_at: '2026-09-02 10:00:00' },
      // Misma persona, pero de una versión de distribución ya reemplazada: nunca debe listarse.
      { id: 'com-desarrollo-vieja', venta_id: 'venta-2', tipo: 'desarrollo', beneficiario_email: 'dev@example.com', distribucion_id: 'dist-vieja', moneda: 'ARS', monto_comision: 250000, monto_base: 700000, porcentaje_snapshot: 45, base_snapshot: 'utilidad_neta_venta', estado: 'calculada_provisional', created_at: '2026-09-01 09:00:00' },
      { id: 'com-comercial-brenda', venta_id: 'venta-2', tipo: 'comercial', beneficiario_email: 'brenda@example.com', distribucion_id: 'dist-vigente', moneda: 'ARS', monto_comision: 100000, monto_base: 700000, porcentaje_snapshot: 25, base_snapshot: 'utilidad_neta_venta', estado: 'calculada_provisional', created_at: '2026-09-02 10:00:00' },
    ],
  };

  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
    };
  }

  function runSelect(sql, p) {
    if (sql.includes('FROM comisiones c') && sql.includes('JOIN ventas v')) {
      const email = p[0];
      return state.comisiones
        .filter((c) => c.beneficiario_email === email)
        .filter((c) => {
          if (!c.distribucion_id) return true;
          const d = state.venta_distribuciones.find((x) => x.id === c.distribucion_id);
          return d && d.estado === 'confirmada';
        })
        .map((c) => {
          const v = state.ventas.find((x) => x.id === c.venta_id);
          return { ...c, codigo_venta: v.codigo_venta, producto: v.producto, mercado: v.mercado };
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    if (sql.startsWith('SELECT * FROM comisiones WHERE id')) return state.comisiones.filter((c) => c.id === p[0]);
    // Cualquier otra consulta (solo la usa calcularFechaPrevistaComision para
    // comisiones todavía estimadas) devuelve vacío — el resultado es
    // "sin fecha prevista", que es todo lo que estas pruebas necesitan.
    return [];
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ roleIdentity: ri, db, url = 'https://rioimpulsodigital.com/interno/api/comisiones/propias', method = 'GET' }) {
  return {
    request: new Request(url, { method }),
    env: { DB: db },
    params: {},
    data: { requestId: 'req-propias-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

async function consultar(email, extra = {}) {
  const db = fakeDb();
  const response = await propiasHandler(fakeContext({ roleIdentity: roleIdentity({ email, role: 'asistente', permissions: PERMISSIONS.asistente, canSell: false, ...extra.identity }), db, url: extra.url }));
  const body = await response.json();
  return { response, body, ids: (body.data?.comisiones || []).map((c) => c.id) };
}

test('GET /comisiones/propias — un beneficiario que NO es vendedor de la venta obtiene su comisión (practicante de realización, sin canSell)', async () => {
  const { response, body, ids } = await consultar('practicante@example.com');
  assert.equal(response.status, 200);
  assert.deepEqual(ids, ['com-practicante']);
  const c = body.data.comisiones[0];
  assert.equal(c.tipo, 'realizacion');
  assert.equal(c.rolRealizacion, 'practicante');
  assert.equal(c.estado, 'programada');
  assert.equal(c.montoComision, 5000);
  assert.equal(c.moneda, 'CLP');
  assert.equal(c.codigoVenta, 'V-20260901-AAAAAA');
  assert.equal(c.fechaProgramadaEfectiva, '2026-10-09');
});

test('GET /comisiones/propias — nunca devuelve comisiones ajenas de la misma venta (vendedor, supervisión, otro realizador)', async () => {
  const { ids } = await consultar('practicante@example.com');
  for (const ajena of ['com-vendedor', 'com-supervision', 'com-responsable']) {
    assert.ok(!ids.includes(ajena), 'no debe incluir la comisión ajena ' + ajena);
  }
});

test('GET /comisiones/propias — realización: el responsable ve únicamente la suya, y el practicante únicamente la suya', async () => {
  const resp = await consultar('responsable@example.com');
  assert.deepEqual(resp.ids, ['com-responsable']);
  assert.equal(resp.body.data.comisiones[0].rolRealizacion, 'responsable');
  const prac = await consultar('practicante@example.com');
  assert.deepEqual(prac.ids, ['com-practicante']);
});

test('GET /comisiones/propias — participante de un proyecto personalizado ve únicamente la suya (y no la de una versión de distribución ya reemplazada)', async () => {
  const { ids, body } = await consultar('dev@example.com');
  assert.deepEqual(ids, ['com-desarrollo']);
  assert.equal(body.data.comisiones[0].tipo, 'desarrollo');
  assert.equal(body.data.comisiones[0].producto, 'proyecto_personalizado');
  assert.ok(!ids.includes('com-desarrollo-vieja'), 'una comisión de una distribución reemplazada nunca se lista');
  assert.ok(!ids.includes('com-comercial-brenda'), 'la comisión comercial de la vendedora no es de este participante');
});

test('GET /comisiones/propias — un usuario sin comisiones recibe una lista vacía (200), no un error', async () => {
  const { response, body } = await consultar('sin-comisiones@example.com');
  assert.equal(response.status, 200);
  assert.deepEqual(body.data.comisiones, []);
});

test('GET /comisiones/propias — el vendedor también recibe la suya (el panel evita el duplicado); un admin recibe solo las SUYAS, nunca todas', async () => {
  const vendedor = await consultar('vendedor@example.com');
  assert.deepEqual(vendedor.ids, ['com-vendedor']);
  const db = fakeDb();
  const response = await propiasHandler(fakeContext({ roleIdentity: roleIdentity({ email: 'brenda@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin }), db }));
  const body = await response.json();
  assert.deepEqual(body.data.comisiones.map((c) => c.id), ['com-comercial-brenda'], 'admin ve solo las comisiones de las que es beneficiaria');
});

test('GET /comisiones/propias — la identidad no se puede manipular desde la solicitud (query string) ni con otro método', async () => {
  const intentos = [
    '?email=alberto@example.com',
    '?beneficiarioEmail=alberto@example.com',
    '?beneficiario_email=vendedor@example.com&usuario=vendedor@example.com',
  ];
  for (const q of intentos) {
    const { ids } = await consultar('practicante@example.com', { url: 'https://rioimpulsodigital.com/interno/api/comisiones/propias' + q });
    assert.deepEqual(ids, ['com-practicante'], 'los parámetros de la solicitud nunca cambian de quién son las comisiones: ' + q);
  }
  const db = fakeDb();
  const post = await propiasHandler(fakeContext({ roleIdentity: roleIdentity({ email: 'practicante@example.com' }), db, method: 'POST' }));
  assert.equal(post.status, 405);
});

test('GET /comisiones/propias — la respuesta no contiene ningún dato prohibido de la venta ni de terceros', async () => {
  const CAMPOS_PERMITIDOS = [
    'id', 'tipo', 'rolRealizacion', 'beneficiarioEmail', 'codigoVenta', 'producto', 'mercado',
    'porcentaje', 'base', 'montoBase', 'moneda', 'montoComision', 'estado', 'fechaHabilitacion',
    'fechaProgramadaOriginal', 'fechaProgramadaEfectiva', 'fechaPagoReal', 'fechaPrevistaPago',
    'motivoRetencionOReprogramacion',
  ].sort();
  for (const email of ['practicante@example.com', 'dev@example.com', 'vendedor@example.com']) {
    const { body } = await consultar(email);
    const texto = JSON.stringify(body);
    for (const c of body.data.comisiones) {
      // (Un campo con valor undefined en este D1 simulado no viaja en el JSON
      // — con D1 real llega null. Lo que importa: nunca sobra ningún campo.)
      const sobrantes = Object.keys(c).filter((k) => !CAMPOS_PERMITIDOS.includes(k));
      assert.deepEqual(sobrantes, [], 'solo el conjunto mínimo de campos aprobado');
    }
    for (const prohibido of ['Peluquería Canina', 'Nua Bushi', 'negocio', 'cliente', 'precio', '60000', '900000', 'fechaInicioPlazo', 'fechaPagoTotalAcreditado', 'costo', 'distribucion', 'empresa', 'materiales', 'facturacion']) {
      assert.ok(!texto.toLowerCase().includes(prohibido.toLowerCase()), `la respuesta de ${email} no debe contener "${prohibido}": ${texto}`);
    }
  }
});
