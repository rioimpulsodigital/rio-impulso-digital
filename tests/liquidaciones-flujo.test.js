// Pruebas de autorización de las rutas de RIO-115 — conversiones y
// liquidaciones. La lógica de negocio ya está probada a fondo en
// tests/liquidaciones.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as conversionesHandler } from '../functions/interno/api/comisiones/conversiones/index.js';
import { onRequest as liquidacionesHandler } from '../functions/interno/api/comisiones/liquidaciones/index.js';
import { onRequest as liquidacionDetalleHandler } from '../functions/interno/api/comisiones/liquidaciones/[liquidacionId]/index.js';
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
      { id: 'com-1', beneficiario_email: 'vendedor@example.com', moneda: 'CLP', monto_comision: 20000, estado: 'programada' },
      { id: 'com-2', beneficiario_email: 'vendedor@example.com', moneda: 'CLP', monto_comision: 15000, estado: 'programada' },
    ],
    conversiones: [],
    transferencias_comision: [{ id: 'tr-1', beneficiario_email: 'vendedor@example.com', fecha: '2026-09-25', moneda_final: 'CLP', monto_total_transferido: 20000, comprobante_nota: null, registrado_por: 'admin@example.com' }],
    transferencia_detalle: [{ id: 'det-1', transferencia_id: 'tr-1', comision_id: 'com-1', monto_incluido: 20000, moneda_original: 'CLP', conversion_id: null }],
    eventos_historial: [],
  };
  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => { runMutation(sql, p); return { success: true }; },
    };
  }
  function runSelect(sql, p) {
    if (sql.startsWith('SELECT * FROM comisiones WHERE id')) return state.comisiones.filter((c) => c.id === p[0]);
    if (sql.startsWith('SELECT id FROM conversiones WHERE comision_id')) return state.conversiones.filter((c) => c.comision_id === p[0]);
    if (sql.startsWith('SELECT * FROM conversiones WHERE comision_id')) return state.conversiones.filter((c) => c.comision_id === p[0]);
    if (sql.startsWith('SELECT id FROM transferencia_detalle WHERE comision_id')) return state.transferencia_detalle.filter((d) => d.comision_id === p[0]);
    if (sql.startsWith('SELECT * FROM transferencias_comision WHERE id')) return state.transferencias_comision.filter((t) => t.id === p[0]);
    if (sql.startsWith('SELECT * FROM transferencia_detalle WHERE transferencia_id')) return state.transferencia_detalle.filter((d) => d.transferencia_id === p[0]);
    if (sql.startsWith('SELECT * FROM transferencias_comision WHERE beneficiario_email')) return state.transferencias_comision.filter((t) => t.beneficiario_email === p[0]);
    if (sql.startsWith('SELECT * FROM transferencias_comision ORDER BY')) return state.transferencias_comision;
    return [];
  }
  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO conversiones')) state.conversiones.push({ id: p[0], comision_id: p[1] });
    else if (sql.startsWith("UPDATE comisiones SET estado = 'pagada'")) { const c = state.comisiones.find((x) => x.id === p[1]); if (c) c.estado = 'pagada'; }
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'POST', body, roleIdentity: ri, db, params = {} }) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/x', init),
    env: { DB: db },
    params,
    data: { requestId: 'req-liq-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

test('conversiones: un ejecutivo NO puede registrar una conversión (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await conversionesHandler(fakeContext({ body: { comisionId: 'com-1', montoOriginal: 1, tipoCambioMostrado: 1, montoConvertido: 1 }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('liquidaciones: un ejecutivo NO puede crear una liquidación (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await liquidacionesHandler(fakeContext({ body: { beneficiarioEmail: 'x@example.com', fecha: '2026-09-25', monedaFinal: 'CLP', comisionIds: ['com-1'], montoTotalTransferido: 20000 }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('liquidaciones: admin SÍ puede crear una liquidación', async () => {
  const db = fakeDb();
  const response = await liquidacionesHandler(fakeContext({ body: { beneficiarioEmail: 'vendedor@example.com', fecha: '2026-09-25', monedaFinal: 'CLP', comisionIds: ['com-2'], montoTotalTransferido: 15000 }, roleIdentity: admin(), db }));
  assert.equal(response.status, 201);
});

test('liquidaciones: GET lista solo las propias para un ejecutivo', async () => {
  const db = fakeDb();
  const response = await liquidacionesHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.liquidaciones.length, 1);
});

test('liquidaciones: GET lista todas para admin', async () => {
  const db = fakeDb();
  const response = await liquidacionesHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db }));
  assert.equal(response.status, 200);
});

test('liquidacion detalle: el beneficiario puede ver la propia y reconciliar el total', async () => {
  const db = fakeDb();
  const response = await liquidacionDetalleHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db, params: { liquidacionId: 'tr-1' } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.sumaDetalle, body.data.liquidacion.montoTotalTransferido);
});

test('liquidacion detalle: un ejecutivo ajeno recibe 404, no la lista de otro', async () => {
  const db = fakeDb();
  const otro = roleIdentity({ email: 'ajeno@example.com' });
  const response = await liquidacionDetalleHandler(fakeContext({ method: 'GET', roleIdentity: otro, db, params: { liquidacionId: 'tr-1' } }));
  assert.equal(response.status, 404);
});

test('liquidacion detalle: admin puede ver cualquiera', async () => {
  const db = fakeDb();
  const response = await liquidacionDetalleHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'tr-1' } }));
  assert.equal(response.status, 200);
});

test('liquidacion detalle: id inexistente devuelve 404', async () => {
  const db = fakeDb();
  const response = await liquidacionDetalleHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'no-existe' } }));
  assert.equal(response.status, 404);
});
