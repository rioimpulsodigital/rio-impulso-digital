// Pruebas de las rutas de configuración de RIO-114 — días no hábiles,
// asignaciones de producción, y el costo de medio de pago prorrateado.
// Autorización: las tres son exclusivas de administración.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as diasNoHabilesHandler } from '../functions/interno/api/comisiones/dias-no-habiles/index.js';
import { onRequest as asignacionesProduccionHandler } from '../functions/interno/api/comisiones/asignaciones-produccion/index.js';
import { onRequest as costosMedioPagoHandler } from '../functions/interno/api/ventas/[id]/costos-medio-pago.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return { email: 'ejecutivo.a@example.com', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb() {
  const state = {
    dias_no_habiles: [],
    componentes: [{ id: 'comp-1', proyecto_id: 'proyecto-1', tipo: 'landing', precio_atribuido: 50000 }],
    asignaciones_produccion: [],
    ventas: [{ id: 'venta-1', vendedor_email: 'ejecutivo.a@example.com', mercado: 'CL', moneda: 'CLP' }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1' }],
    costos_directos: [],
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
    if (sql.startsWith('SELECT * FROM dias_no_habiles')) return state.dias_no_habiles;
    if (sql.startsWith('SELECT id, tipo FROM componentes WHERE id')) return state.componentes.filter((c) => c.id === p[0]);
    if (sql.startsWith('SELECT id FROM asignaciones_produccion WHERE componente_id')) return state.asignaciones_produccion.filter((a) => a.componente_id === p[0] && a.rol === p[1]);
    if (sql.includes('FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT id FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT id, precio_atribuido FROM componentes WHERE proyecto_id')) return state.componentes.filter((c) => c.proyecto_id === p[0]);
    return [];
  }
  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO dias_no_habiles')) {
      const dup = state.dias_no_habiles.some((d) => d.mercado === p[1] && d.fecha === p[2]);
      if (dup) throw new Error('UNIQUE constraint failed');
      state.dias_no_habiles.push({ id: p[0], mercado: p[1], fecha: p[2], motivo: p[3], created_by: p[4] });
    } else if (sql.startsWith('INSERT INTO asignaciones_produccion')) {
      state.asignaciones_produccion.push({ id: p[0], usuario_email: p[1], componente_id: p[2], rol: p[3], asignado_por: p[4] });
    } else if (sql.startsWith('INSERT INTO costos_directos')) {
      state.costos_directos.push({ id: p[0], componente_id: p[1], tipo: p[2], monto: p[3], moneda: p[4], autorizado_por: p[5] });
    }
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
    data: { requestId: 'req-config-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

// --- días no hábiles ---

test('dias-no-habiles: un ejecutivo NO puede registrar un feriado (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await diasNoHabilesHandler(fakeContext({ body: { mercado: 'CL', fecha: '2026-09-18', motivo: 'Fiestas Patrias' }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('dias-no-habiles: admin SÍ puede registrar un feriado', async () => {
  const db = fakeDb();
  const response = await diasNoHabilesHandler(fakeContext({ body: { mercado: 'CL', fecha: '2026-09-18', motivo: 'Fiestas Patrias' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.dias_no_habiles.length, 1);
});

test('dias-no-habiles: rechaza mercado inválido', async () => {
  const db = fakeDb();
  const response = await diasNoHabilesHandler(fakeContext({ body: { mercado: 'MX', fecha: '2026-09-18', motivo: 'x' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

test('dias-no-habiles: cualquier usuario identificado puede listarlos (no expone datos financieros)', async () => {
  const db = fakeDb();
  db._state.dias_no_habiles.push({ id: '1', mercado: 'CL', fecha: '2026-09-18', motivo: 'Fiestas Patrias', created_by: 'admin@example.com' });
  const response = await diasNoHabilesHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.diasNoHabiles.length, 1);
});

// --- asignaciones de producción ---

test('asignaciones-produccion: un ejecutivo NO puede asignar un componente (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-1', usuarioEmail: 'asistente@example.com', rol: 'produccion' }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('asignaciones-produccion: admin SÍ puede asignar un componente Landing', async () => {
  const db = fakeDb();
  const response = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-1', usuarioEmail: 'asistente@example.com', rol: 'produccion' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.asignaciones_produccion[0].usuario_email, 'asistente@example.com');
  assert.equal(db._state.asignaciones_produccion[0].rol, 'produccion');
});

test('asignaciones-produccion: rol inválido devuelve 400', async () => {
  const db = fakeDb();
  const response = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-1', usuarioEmail: 'asistente@example.com', rol: 'algo_raro' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

test('asignaciones-produccion: un componente Ficha se rechaza — esta distribución no aplica a Fichas', async () => {
  const db = fakeDb();
  db._state.componentes.push({ id: 'comp-ficha', proyecto_id: 'proyecto-1', tipo: 'ficha', precio_atribuido: 50000 });
  const response = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-ficha', usuarioEmail: 'asistente@example.com', rol: 'produccion' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

test('asignaciones-produccion: el mismo rol en un componente ya asignado devuelve 409, nunca sobrescribe en silencio', async () => {
  const db = fakeDb();
  await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-1', usuarioEmail: 'asistente.a@example.com', rol: 'produccion' }, roleIdentity: admin(), db }));
  const response = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-1', usuarioEmail: 'asistente.b@example.com', rol: 'produccion' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 409);
  assert.equal(db._state.asignaciones_produccion.length, 1);
  assert.equal(db._state.asignaciones_produccion[0].usuario_email, 'asistente.a@example.com');
});

test('asignaciones-produccion: el MISMO componente admite un rol distinto (produccion y desarrollo son independientes)', async () => {
  const db = fakeDb();
  const r1 = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-1', usuarioEmail: 'practicante@example.com', rol: 'produccion' }, roleIdentity: admin(), db }));
  const r2 = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'comp-1', usuarioEmail: 'brenda@example.com', rol: 'desarrollo' }, roleIdentity: admin(), db }));
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(db._state.asignaciones_produccion.length, 2);
});

test('asignaciones-produccion: componente inexistente devuelve 404', async () => {
  const db = fakeDb();
  const response = await asignacionesProduccionHandler(fakeContext({ body: { componenteId: 'no-existe', usuarioEmail: 'asistente@example.com', rol: 'produccion' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 404);
});

// --- costo de medio de pago ---

test('costos-medio-pago: el vendedor NO puede registrarlo (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await costosMedioPagoHandler(fakeContext({ body: { tipo: 'medio_pago', monto: 1000 }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 403);
});

test('costos-medio-pago: admin SÍ puede registrarlo', async () => {
  const db = fakeDb();
  const response = await costosMedioPagoHandler(fakeContext({ body: { tipo: 'medio_pago', monto: 1000 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 201);
  assert.equal(db._state.costos_directos.length, 1);
  assert.equal(db._state.costos_directos[0].monto, 1000);
});
