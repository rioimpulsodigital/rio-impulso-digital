// Pruebas de GET /interno/api/comisiones?estado=programada — RIO-122
// (conectar Liquidaciones al Panel Administrativo). Esta ruta es
// exclusivamente informativa (lista comisiones elegibles para armar una
// liquidación); toda la validación real de qué se puede liquidar sigue
// viviendo en registrarLiquidacion() (ya probado a fondo en
// tests/liquidaciones.test.js y tests/liquidaciones-flujo.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as comisionesHandler } from '../functions/interno/api/comisiones/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return { email: 'vendedor@example.com', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb() {
  const state = {
    comisiones: [
      { id: 'com-cl-programada', venta_id: 'venta-cl', beneficiario_email: 'vendedor@example.com', tipo: 'comercial', moneda: 'CLP', monto_comision: 20000, estado: 'programada', fecha_programada_efectiva: '2026-10-10' },
      { id: 'com-ar-sin-conversion', venta_id: 'venta-ar', beneficiario_email: 'ejecutivo.ar@example.com', tipo: 'comercial', moneda: 'ARS', monto_comision: 50000, estado: 'programada', fecha_programada_efectiva: '2026-10-09' },
      { id: 'com-ar-ya-convertida', venta_id: 'venta-ar', beneficiario_email: 'ejecutivo.ar@example.com', tipo: 'supervision', moneda: 'ARS', monto_comision: 10000, estado: 'programada', fecha_programada_efectiva: '2026-10-09' },
      { id: 'com-no-programada', venta_id: 'venta-cl', beneficiario_email: 'vendedor@example.com', tipo: 'realizacion', moneda: 'CLP', monto_comision: 5000, estado: 'calculada_provisional', fecha_programada_efectiva: null },
    ],
    ventas: [
      { id: 'venta-cl', codigo_venta: 'V-CL-1', mercado: 'CL', cliente_id: 'cliente-cl' },
      { id: 'venta-ar', codigo_venta: 'V-AR-1', mercado: 'AR', cliente_id: 'cliente-ar' },
    ],
    clientes: [
      { id: 'cliente-cl', negocio: 'Peluquería Canina' },
      { id: 'cliente-ar', negocio: 'Distribuidora del Sur' },
    ],
    usuarios: [
      { email: 'vendedor@example.com', nombre: 'Vendedor de Prueba' },
      { email: 'ejecutivo.ar@example.com', nombre: 'Ejecutiva Argentina' },
    ],
    conversiones: [
      { id: 'conv-1', comision_id: 'com-ar-ya-convertida', monto_convertido: 18000, moneda_final: 'CLP', tipo_cambio_mostrado: 1.8, monto_original: 10000 },
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
    if (sql.includes('FROM comisiones c JOIN ventas v')) {
      const mercados = p; // todos los params son los mercados del IN (...)
      return state.comisiones.filter((c) => {
        if (c.estado !== 'programada') return false;
        const venta = state.ventas.find((v) => v.id === c.venta_id);
        return venta && mercados.includes(venta.mercado);
      });
    }
    if (sql.startsWith('SELECT nombre FROM usuarios WHERE email')) return state.usuarios.filter((u) => u.email === p[0]);
    if (sql.startsWith('SELECT codigo_venta, mercado, cliente_id FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT negocio FROM clientes WHERE id')) return state.clientes.filter((c) => c.id === p[0]);
    if (sql.startsWith('SELECT id, monto_convertido, moneda_final, tipo_cambio_mostrado, monto_original FROM conversiones WHERE comision_id')) {
      return state.conversiones.filter((c) => c.comision_id === p[0]);
    }
    return [];
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ roleIdentity: ri, db, queryString = '' }) {
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/comisiones' + queryString, { method: 'GET' }),
    env: { DB: db },
    params: {},
    data: { requestId: 'req-comisiones-programadas-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

test('GET /comisiones — un ejecutivo NO puede listar (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: roleIdentity(), db, queryString: '?estado=programada' }));
  assert.equal(response.status, 403);
});

test('GET /comisiones — admin sin ?estado=programada recibe un error de validación explícito', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: admin(), db, queryString: '' }));
  assert.equal(response.status, 400);
});

test('GET /comisiones — admin con ?estado=programada ve solo las comisiones programada de sus mercados', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: admin(), db, queryString: '?estado=programada' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = body.data.comisiones.map((c) => c.id).sort();
  assert.deepEqual(ids, ['com-ar-sin-conversion', 'com-ar-ya-convertida', 'com-cl-programada']);
});

test('GET /comisiones — un admin cuyo mercado no incluye AR no ve las comisiones de venta-ar', async () => {
  const db = fakeDb();
  const soloCl = admin({ allowedMarkets: ['CL'] });
  const response = await comisionesHandler(fakeContext({ roleIdentity: soloCl, db, queryString: '?estado=programada' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = body.data.comisiones.map((c) => c.id);
  assert.deepEqual(ids, ['com-cl-programada']);
});

test('GET /comisiones — una comisión CLP nunca requiere conversión', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: admin(), db, queryString: '?estado=programada' }));
  const body = await response.json();
  const clp = body.data.comisiones.find((c) => c.id === 'com-cl-programada');
  assert.equal(clp.requiereConversion, false);
  assert.equal(clp.conversion, null);
});

test('GET /comisiones — una comisión ARS sin conversión registrada la requiere', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: admin(), db, queryString: '?estado=programada' }));
  const body = await response.json();
  const ars = body.data.comisiones.find((c) => c.id === 'com-ar-sin-conversion');
  assert.equal(ars.requiereConversion, true);
  assert.equal(ars.conversion, null);
});

test('GET /comisiones — una comisión ARS ya convertida NO requiere conversión y expone el detalle de la conversión', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: admin(), db, queryString: '?estado=programada' }));
  const body = await response.json();
  const convertida = body.data.comisiones.find((c) => c.id === 'com-ar-ya-convertida');
  assert.equal(convertida.requiereConversion, false);
  assert.ok(convertida.conversion);
  assert.equal(convertida.conversion.montoConvertido, 18000);
  assert.equal(convertida.conversion.monedaFinal, 'CLP');
});

test('GET /comisiones — una comisión que NO está en estado programada nunca aparece', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: admin(), db, queryString: '?estado=programada' }));
  const body = await response.json();
  assert.ok(!body.data.comisiones.some((c) => c.id === 'com-no-programada'));
});

test('GET /comisiones — expone cliente, código de venta y beneficiario para armar la selección', async () => {
  const db = fakeDb();
  const response = await comisionesHandler(fakeContext({ roleIdentity: admin(), db, queryString: '?estado=programada' }));
  const body = await response.json();
  const clp = body.data.comisiones.find((c) => c.id === 'com-cl-programada');
  assert.equal(clp.codigoVenta, 'V-CL-1');
  assert.equal(clp.clienteNegocio, 'Peluquería Canina');
  assert.equal(clp.beneficiarioNombre, 'Vendedor de Prueba');
  assert.equal(clp.mercado, 'CL');
});
