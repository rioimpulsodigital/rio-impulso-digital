// Pruebas de las rutas nuevas de RIO-114 — autorización: comisiones
// (listar / marcar pagada), costos directos, y resolución de incidencias.
// La lógica de negocio (gate, cálculo, calendario) ya se prueba a fondo en
// tests/comisiones.test.js — acá se prueba que cada ruta exige el permiso
// correcto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as comisionesListHandler } from '../functions/interno/api/ventas/[id]/comisiones/index.js';
import { onRequest as comisionPagarHandler } from '../functions/interno/api/ventas/[id]/comisiones/[comisionId]/index.js';
import { onRequest as costosHandler } from '../functions/interno/api/ventas/[id]/componentes/[componenteId]/costos.js';
import { onRequest as incidenciaResolverHandler } from '../functions/interno/api/ventas/[id]/incidencias/[incidenciaId]/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

const VENDEDOR = 'vendedor.a@example.com';

function roleIdentity(overrides = {}) {
  return { email: VENDEDOR, role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}

function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb() {
  const state = {
    ventas: [{ id: 'venta-1', vendedor_email: VENDEDOR, mercado: 'CL', moneda: 'CLP' }],
    componentes: [{ id: 'comp-x', proyecto_id: 'proyecto-1' }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1' }],
    comisiones: [
      { id: 'com-comercial', venta_id: 'venta-1', tipo: 'comercial', beneficiario_email: VENDEDOR, estado: 'programada' },
      { id: 'com-supervision', venta_id: 'venta-1', tipo: 'supervision', beneficiario_email: 'supervisor@example.com', estado: 'programada' },
    ],
    costos_directos: [],
    incidencias: [{ id: 'inc-1', venta_id: 'venta-1', tipo: 'disputa', estado: 'abierta', motivo: 'x' }],
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
    if (sql.includes('FROM ventas WHERE id')) {
      return state.ventas.filter((v) => v.id === p[0]);
    }
    if (sql.startsWith('SELECT * FROM comisiones WHERE venta_id') && sql.includes('beneficiario_email')) {
      return state.comisiones.filter((c) => c.venta_id === p[0] && c.beneficiario_email === p[1]);
    }
    if (sql.startsWith('SELECT * FROM comisiones WHERE venta_id')) return state.comisiones.filter((c) => c.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM comisiones WHERE id')) return state.comisiones.filter((c) => c.id === p[0]);
    if (sql.includes('FROM componentes WHERE id') && sql.includes('proyecto_id IN')) {
      return state.componentes.filter((c) => c.id === p[0]).filter(() => state.proyectos.some((pr) => pr.id === state.componentes.find((x) => x.id === p[0])?.proyecto_id && pr.venta_id === p[1]));
    }
    if (sql.startsWith('SELECT * FROM incidencias WHERE id')) return state.incidencias.filter((i) => i.id === p[0]);
    return [];
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO costos_directos')) {
      state.costos_directos.push({ id: p[0], componente_id: p[1], tipo: p[2], monto: p[3], moneda: p[4], autorizado_por: p[5] });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0] });
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'pagada'")) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) { c.estado = 'pagada'; c.fecha_pago_real = p[0]; }
    } else if (sql.startsWith("UPDATE incidencias SET estado = 'resuelta'")) {
      const i = state.incidencias.find((x) => x.id === p[0]);
      if (i) i.estado = 'resuelta';
    }
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'GET', body, roleIdentity: ri, db, params = { id: 'venta-1' } }) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas/venta-1/x', init),
    env: { DB: db },
    params,
    data: { requestId: 'req-com-flujo', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

// --- Comisiones: listar ---

test('comisiones: el vendedor ve su propia comisión comercial, no la de supervisión de otro', async () => {
  const db = fakeDb();
  const response = await comisionesListHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.comisiones.length, 1);
  assert.equal(body.data.comisiones[0].tipo, 'comercial');
});

test('comisiones: admin de ese mercado ve TODAS las comisiones de la venta', async () => {
  const db = fakeDb();
  const response = await comisionesListHandler(fakeContext({ roleIdentity: admin(), db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.comisiones.length, 2);
});

test('comisiones: un ejecutivo totalmente ajeno (ni vendedor ni beneficiario) recibe 404', async () => {
  const db = fakeDb();
  const otro = roleIdentity({ email: 'ejecutivo.ajeno@example.com' });
  const response = await comisionesListHandler(fakeContext({ roleIdentity: otro, db }));
  assert.equal(response.status, 404);
});

// --- Comisiones: marcar pagada ---

test('comisiones: el vendedor NO puede marcar su propia comisión como pagada (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await comisionPagarHandler(fakeContext({ method: 'POST', body: { action: 'marcar-pagada' }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', comisionId: 'com-comercial' } }));
  assert.equal(response.status, 403);
});

test('comisiones: admin SÍ puede marcar una comisión programada como pagada', async () => {
  const db = fakeDb();
  const response = await comisionPagarHandler(fakeContext({ method: 'POST', body: { action: 'marcar-pagada' }, roleIdentity: admin(), db, params: { id: 'venta-1', comisionId: 'com-comercial' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.comisiones.find((c) => c.id === 'com-comercial').estado, 'pagada');
});

// --- Costos directos ---

test('costos: el vendedor NO puede registrar un costo directo (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await costosHandler(fakeContext({ method: 'POST', body: { tipo: 'dominio_propio', monto: 15000 }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 403);
});

test('costos: admin SÍ puede registrar un costo directo', async () => {
  const db = fakeDb();
  const response = await costosHandler(fakeContext({ method: 'POST', body: { tipo: 'dominio_propio', monto: 15000 }, roleIdentity: admin(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 201);
  assert.equal(db._state.costos_directos.length, 1);
  assert.equal(db._state.costos_directos[0].autorizado_por, admin().email);
});

// --- Incidencias: resolver ---

test('incidencias: un ejecutivo NO puede resolver una incidencia (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await incidenciaResolverHandler(fakeContext({ method: 'POST', body: { action: 'resolver' }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', incidenciaId: 'inc-1' } }));
  assert.equal(response.status, 403);
});

test('incidencias: admin SÍ puede resolver una incidencia', async () => {
  const db = fakeDb();
  const response = await incidenciaResolverHandler(fakeContext({ method: 'POST', body: { action: 'resolver' }, roleIdentity: admin(), db, params: { id: 'venta-1', incidenciaId: 'inc-1' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.incidencias.find((i) => i.id === 'inc-1').estado, 'resuelta');
});

test('incidencias: action inválida se rechaza incluso para admin', async () => {
  const db = fakeDb();
  const response = await incidenciaResolverHandler(fakeContext({ method: 'POST', body: { action: 'volar' }, roleIdentity: admin(), db, params: { id: 'venta-1', incidenciaId: 'inc-1' } }));
  assert.equal(response.status, 400);
});

test('incidencias: incidencia inexistente devuelve 404', async () => {
  const db = fakeDb();
  const response = await incidenciaResolverHandler(fakeContext({ method: 'POST', body: { action: 'resolver' }, roleIdentity: admin(), db, params: { id: 'venta-1', incidenciaId: 'no-existe' } }));
  assert.equal(response.status, 404);
});
