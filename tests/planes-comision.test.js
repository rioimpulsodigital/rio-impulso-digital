// Pruebas de RIO-119 (tercer bloque, items 2-4, 02/09/2026): planes de
// comisión editables/versionados, asignaciones de planes a personas, y
// validación de la distribución económica.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as planesHandler } from '../functions/interno/api/planes-comision/index.js';
import { onRequest as planDetalleHandler } from '../functions/interno/api/planes-comision/[id]/index.js';
import { onRequest as asignacionesHandler } from '../functions/interno/api/planes-comision/[id]/asignaciones/index.js';
import { onRequest as simularHandler } from '../functions/interno/api/planes-comision/simular/index.js';
import { validarDistribucion } from '../functions/_shared/comisiones.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return { email: 'ejecutivo.a@example.com', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb() {
  const state = {
    planes_comision: [],
    asignaciones_plan_comision: [],
    usuarios: [{ id: 1, email: 'vendedor@example.com', nombre: 'Vendedor Uno' }],
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
    if (sql.startsWith('SELECT * FROM planes_comision ORDER BY')) return state.planes_comision;
    if (sql.startsWith('SELECT * FROM planes_comision WHERE id')) return state.planes_comision.filter((pl) => pl.id === p[0]);
    if (sql.startsWith('SELECT id FROM planes_comision WHERE id')) return state.planes_comision.filter((pl) => pl.id === p[0]).map((pl) => ({ id: pl.id }));
    if (sql.startsWith('SELECT id FROM usuarios WHERE email')) return state.usuarios.filter((u) => u.email === p[0]).map((u) => ({ id: u.id }));
    if (sql.includes('FROM asignaciones_plan_comision a JOIN usuarios')) {
      return state.asignaciones_plan_comision
        .filter((a) => a.plan_id === p[0])
        .map((a) => {
          const u = state.usuarios.find((x) => x.id === a.usuario_id);
          return { id: a.id, valid_from: a.valid_from, valid_until: a.valid_until, note: a.note, created_by: a.created_by, created_at: a.created_at, usuario_email: u?.email, usuario_nombre: u?.nombre };
        });
    }
    if (sql.startsWith('SELECT id, valid_until FROM asignaciones_plan_comision WHERE id')) {
      return state.asignaciones_plan_comision.filter((a) => a.id === p[0] && a.plan_id === p[1]).map((a) => ({ id: a.id, valid_until: a.valid_until }));
    }
    return [];
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO planes_comision')) {
      state.planes_comision.push({
        id: p[0], tipo: p[1], contexto_realizacion: p[2], porcentaje: p[3], base: p[4],
        productos_alcanzados: p[5], mercados_alcanzados: p[6], note: p[7], created_by: p[8],
        estado: 'activo', valid_from: '2026-09-02 00:00:00', valid_until: null, created_at: '2026-09-02 00:00:00',
      });
    } else if (sql.startsWith("UPDATE planes_comision SET estado = 'inactivo'")) {
      const plan = state.planes_comision.find((pl) => pl.id === p[0]);
      if (plan) { plan.estado = 'inactivo'; plan.valid_until = '2026-09-02 01:00:00'; }
    } else if (sql.startsWith('INSERT INTO asignaciones_plan_comision')) {
      // columnas dinámicas: id, usuario_id, plan_id, created_by [, valid_from] [, valid_until] [, note]
      const cols = sql.match(/\(([^)]+)\)/)[1].split(',').map((c) => c.trim());
      const row = { valid_from: '2026-09-02 00:00:00', valid_until: null, note: null, created_at: '2026-09-02 00:00:00' };
      cols.forEach((c, i) => { row[c] = p[i]; });
      state.asignaciones_plan_comision.push(row);
    } else if (sql.startsWith("UPDATE asignaciones_plan_comision SET valid_until")) {
      const a = state.asignaciones_plan_comision.find((x) => x.id === p[0]);
      if (a) a.valid_until = '2026-09-02 02:00:00';
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ entidad: p[2], entidad_id: p[3] });
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
    data: { requestId: 'req-planes-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

function planBody(overrides = {}) {
  return {
    tipo: 'comercial', porcentaje: 40, base: 'utilidad_neta_venta',
    productosAlcanzados: ['ficha', 'generico'], mercadosAlcanzados: ['CL'],
    ...overrides,
  };
}

// --- crear plan ---

test('planes-comision: un ejecutivo NO puede crear un plan (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await planesHandler(fakeContext({ body: planBody(), roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('planes-comision: admin SÍ puede crear un plan', async () => {
  const db = fakeDb();
  const response = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.planes_comision.length, 1);
  assert.equal(db._state.planes_comision[0].estado, 'activo');
});

test('planes-comision: rechaza tipo inválido', async () => {
  const db = fakeDb();
  const response = await planesHandler(fakeContext({ body: planBody({ tipo: 'inventado' }), roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

test('planes-comision: un plan de tipo realizacion requiere contextoRealizacion', async () => {
  const db = fakeDb();
  const response = await planesHandler(fakeContext({ body: planBody({ tipo: 'realizacion', contextoRealizacion: undefined }), roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

test('planes-comision: contextoRealizacion en un plan NO realizacion se rechaza', async () => {
  const db = fakeDb();
  const response = await planesHandler(fakeContext({ body: planBody({ contextoRealizacion: 'solo' }), roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

test('planes-comision: rechaza porcentaje negativo o mayor a 100', async () => {
  const db = fakeDb();
  const r1 = await planesHandler(fakeContext({ body: planBody({ porcentaje: -5 }), roleIdentity: admin(), db }));
  const r2 = await planesHandler(fakeContext({ body: planBody({ porcentaje: 101 }), roleIdentity: admin(), db }));
  assert.equal(r1.status, 400);
  assert.equal(r2.status, 400);
});

test('planes-comision: GET lista los planes creados', async () => {
  const db = fakeDb();
  await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const response = await planesHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db }));
  const body = await response.json();
  assert.equal(body.data.planes.length, 1);
  assert.deepEqual(body.data.planes[0].productosAlcanzados, ['ficha', 'generico']);
});

// --- desactivar / nueva-version ---

test('planes-comision/:id desactivar: cierra el plan sin reemplazo', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const response = await planDetalleHandler(fakeContext({ body: { action: 'desactivar' }, roleIdentity: admin(), db, params: { id: data.id } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.planes_comision[0].estado, 'inactivo');
});

test('planes-comision/:id nueva-version: nunca muta el porcentaje del plan viejo, crea uno nuevo', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody({ porcentaje: 40 }), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const response = await planDetalleHandler(fakeContext({ body: { action: 'nueva-version', porcentaje: 35 }, roleIdentity: admin(), db, params: { id: data.id } }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.plan.porcentaje, 35);
  assert.equal(db._state.planes_comision.length, 2);
  const viejo = db._state.planes_comision.find((pl) => pl.id === data.id);
  assert.equal(viejo.porcentaje, 40); // nunca mutado
  assert.equal(viejo.estado, 'inactivo');
});

test('planes-comision/:id: un ejecutivo no puede desactivar ni versionar', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const response = await planDetalleHandler(fakeContext({ body: { action: 'desactivar' }, roleIdentity: roleIdentity(), db, params: { id: data.id } }));
  assert.equal(response.status, 403);
});

test('planes-comision/:id: plan inexistente devuelve 404', async () => {
  const db = fakeDb();
  const response = await planDetalleHandler(fakeContext({ body: { action: 'desactivar' }, roleIdentity: admin(), db, params: { id: 'no-existe' } }));
  assert.equal(response.status, 404);
});

// --- asignaciones ---

test('asignaciones: admin asigna un plan a una persona existente', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const response = await asignacionesHandler(fakeContext({ body: { action: 'asignar', usuarioEmail: 'vendedor@example.com' }, roleIdentity: admin(), db, params: { id: data.id } }));
  assert.equal(response.status, 201);
  assert.equal(db._state.asignaciones_plan_comision.length, 1);
  assert.equal(db._state.asignaciones_plan_comision[0].usuario_id, 1);
});

test('asignaciones: rechaza asignar a una persona que no existe', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const response = await asignacionesHandler(fakeContext({ body: { action: 'asignar', usuarioEmail: 'fantasma@example.com' }, roleIdentity: admin(), db, params: { id: data.id } }));
  assert.equal(response.status, 400);
});

test('asignaciones: un ejecutivo no puede asignar planes', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const response = await asignacionesHandler(fakeContext({ body: { action: 'asignar', usuarioEmail: 'vendedor@example.com' }, roleIdentity: roleIdentity(), db, params: { id: data.id } }));
  assert.equal(response.status, 403);
});

test('asignaciones: GET lista las asignaciones del plan con nombre resuelto', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  await asignacionesHandler(fakeContext({ body: { action: 'asignar', usuarioEmail: 'vendedor@example.com' }, roleIdentity: admin(), db, params: { id: data.id } }));
  const response = await asignacionesHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { id: data.id } }));
  const body = await response.json();
  assert.equal(body.data.asignaciones.length, 1);
  assert.equal(body.data.asignaciones[0].usuarioNombre, 'Vendedor Uno');
});

test('asignaciones: cerrar una asignación vigente nunca borra la fila, solo cierra valid_until', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const asignar = await asignacionesHandler(fakeContext({ body: { action: 'asignar', usuarioEmail: 'vendedor@example.com' }, roleIdentity: admin(), db, params: { id: data.id } }));
  const { data: asigData } = await asignar.json();
  const response = await asignacionesHandler(fakeContext({ body: { action: 'cerrar', id: asigData.id }, roleIdentity: admin(), db, params: { id: data.id } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.asignaciones_plan_comision.length, 1); // sigue existiendo
  assert.ok(db._state.asignaciones_plan_comision[0].valid_until); // pero cerrada
});

test('asignaciones: cerrar una asignación ya cerrada devuelve 400, nunca la reabre en silencio', async () => {
  const db = fakeDb();
  const crear = await planesHandler(fakeContext({ body: planBody(), roleIdentity: admin(), db }));
  const { data } = await crear.json();
  const asignar = await asignacionesHandler(fakeContext({ body: { action: 'asignar', usuarioEmail: 'vendedor@example.com' }, roleIdentity: admin(), db, params: { id: data.id } }));
  const { data: asigData } = await asignar.json();
  await asignacionesHandler(fakeContext({ body: { action: 'cerrar', id: asigData.id }, roleIdentity: admin(), db, params: { id: data.id } }));
  const response = await asignacionesHandler(fakeContext({ body: { action: 'cerrar', id: asigData.id }, roleIdentity: admin(), db, params: { id: data.id } }));
  assert.equal(response.status, 400);
});

// --- validarDistribucion (función pura) ---

test('validarDistribucion: 100% exacto y completo se acepta', () => {
  const r = validarDistribucion([
    { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 40 },
    { concepto: 'supervision', beneficiarioEmail: 'b@example.com', porcentaje: 10 },
    { concepto: 'realizacion', beneficiarioEmail: 'c@example.com', porcentaje: 30 },
    { concepto: 'empresa', beneficiarioEmail: 'empresa', porcentaje: 20 },
  ]);
  assert.equal(r.valida, true);
  assert.equal(r.completa, true);
  assert.equal(r.suma, 100);
  assert.equal(r.empresaPorcentaje, 0);
});

test('validarDistribucion: 101% se rechaza', () => {
  const r = validarDistribucion([
    { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 41 },
    { concepto: 'supervision', beneficiarioEmail: 'b@example.com', porcentaje: 10 },
    { concepto: 'realizacion', beneficiarioEmail: 'c@example.com', porcentaje: 30 },
    { concepto: 'empresa', beneficiarioEmail: 'empresa', porcentaje: 20 },
  ]);
  assert.equal(r.valida, false);
  assert.ok(r.errores.some((e) => e.includes('no puede exceder 100%')));
});

test('validarDistribucion: un porcentaje negativo se rechaza', () => {
  const r = validarDistribucion([{ concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: -5 }]);
  assert.equal(r.valida, false);
});

test('validarDistribucion: una participación sin beneficiario queda visible como faltante y bloquea', () => {
  const r = validarDistribucion([
    { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 40 },
    { concepto: 'supervision', beneficiarioEmail: null, porcentaje: 10 },
  ]);
  assert.equal(r.valida, false);
  assert.ok(r.errores.some((e) => e.includes('supervision') && e.includes('10%')));
  assert.equal(r.participaciones.find((p) => p.concepto === 'supervision').beneficiarioEmail, null);
});

test('validarDistribucion: una distribución incompleta (suma < 100) es válida pero no "completa" — no puede cerrar una operación real', () => {
  const r = validarDistribucion([{ concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 40 }]);
  assert.equal(r.valida, true);
  assert.equal(r.completa, false);
  assert.equal(r.empresaPorcentaje, 60);
});

test('validarDistribucion: una participación duplicada (mismo concepto + beneficiario) se rechaza', () => {
  const r = validarDistribucion([
    { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 20 },
    { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 20 },
  ]);
  assert.equal(r.valida, false);
  assert.ok(r.errores.some((e) => e.includes('duplicada')));
});

test('validarDistribucion: una persona con dos participaciones distintas (conceptos diferentes) NO se considera duplicada', () => {
  const r = validarDistribucion([
    { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 20 },
    { concepto: 'realizacion_responsable', beneficiarioEmail: 'a@example.com', porcentaje: 20 },
  ]);
  assert.equal(r.valida, true);
  assert.equal(r.participaciones.length, 2);
});

test('validarDistribucion: venta directa sin supervisión — el 10% de supervisión no se modela como fila, va implícito a empresa', () => {
  const r = validarDistribucion([
    { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 40 },
    { concepto: 'realizacion', beneficiarioEmail: 'c@example.com', porcentaje: 30 },
  ]);
  assert.equal(r.valida, true);
  assert.equal(r.empresaPorcentaje, 30); // 20% base + 10% de supervisión no aplicada
});

// --- endpoint /simular ---

test('planes-comision/simular: un ejecutivo no puede simular (exclusivo de admin)', async () => {
  const response = await simularHandler(fakeContext({ body: { participaciones: [{ concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 40 }] }, roleIdentity: roleIdentity() }));
  assert.equal(response.status, 403);
});

test('planes-comision/simular: admin recibe el resultado de la validación sin tocar la base de datos', async () => {
  const response = await simularHandler(fakeContext({
    body: { participaciones: [{ concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 40 }, { concepto: 'empresa', beneficiarioEmail: 'empresa', porcentaje: 60 }] },
    roleIdentity: admin(),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.completa, true);
  assert.equal(body.data.suma, 100);
});

test('planes-comision/simular: rechaza un cuerpo sin participaciones', async () => {
  const response = await simularHandler(fakeContext({ body: {}, roleIdentity: admin() }));
  assert.equal(response.status, 400);
});
