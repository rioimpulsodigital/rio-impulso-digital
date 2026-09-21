// Pruebas de POST /interno/api/comisiones/reevaluar-vencidas — RIO-122,
// ruta TEMPORAL creada exclusivamente para destrabar el UAT de
// Liquidaciones en Preview (sin cron activo todavía). No reimplementa
// ninguna lógica: llama a reevaluarComisionesVencidasDelSistema(), ya
// probada en tests/comisiones.test.js — esta suite solo verifica que la
// ruta HTTP la invoque correctamente y respete el permiso de admin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as reevaluarHandler } from '../functions/interno/api/comisiones/reevaluar-vencidas/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return { email: 'vendedor@example.com', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function haceDias(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function fakeDb() {
  const state = {
    comisiones: [
      // Cumple las 3 condiciones — debe pasar a 'programada'.
      {
        id: 'com-lista', venta_id: 'venta-1', beneficiario_email: 'brenda@rioimpulsodigital.com',
        estado: 'calculada_provisional', distribucion_id: null, moneda: 'ARS', monto_comision: 48000,
        fecha_inicio_plazo: haceDias(20), fecha_cumplimiento_plazo: null, fecha_pago_total_acreditado: haceDias(20),
      },
      // Todavía sin pago acreditado — no debe avanzar.
      {
        id: 'com-sin-pago', venta_id: 'venta-1', beneficiario_email: 'alberto@example.com',
        estado: 'calculada_provisional', distribucion_id: null, moneda: 'ARS', monto_comision: 12000,
        fecha_inicio_plazo: haceDias(20), fecha_cumplimiento_plazo: null, fecha_pago_total_acreditado: null,
      },
      // Ya programada — la reevaluación no debe tocarla (vuelve early).
      {
        id: 'com-ya-programada', venta_id: 'venta-2', beneficiario_email: 'otra@example.com',
        estado: 'programada', distribucion_id: null, moneda: 'CLP', monto_comision: 20000,
        fecha_inicio_plazo: haceDias(20), fecha_cumplimiento_plazo: haceDias(10), fecha_pago_total_acreditado: haceDias(20),
      },
    ],
    ventas: [
      { id: 'venta-1', mercado: 'AR', producto: 'generico' },
      { id: 'venta-2', mercado: 'CL', producto: 'ficha' },
    ],
    incidencias: [],
    eventos_historial: [],
    dias_no_habiles: [],
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
    if (sql.startsWith("SELECT id FROM comisiones WHERE estado IN")) {
      return state.comisiones.filter((c) => ['calculada_provisional', 'retenida'].includes(c.estado)).map((c) => ({ id: c.id }));
    }
    if (sql.startsWith('SELECT * FROM comisiones WHERE id')) return state.comisiones.filter((c) => c.id === p[0]);
    if (sql.startsWith('SELECT id FROM incidencias WHERE venta_id')) {
      return state.incidencias.filter((i) => i.venta_id === p[0] && i.estado === 'abierta');
    }
    if (sql.startsWith('SELECT producto FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT mercado FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT 1 AS x FROM dias_no_habiles')) return state.dias_no_habiles.filter((d) => d.mercado === p[0] && d.fecha === p[1]);
    throw new Error('consulta inesperada en test: ' + sql);
  }

  function runMutation(sql, p) {
    if (sql.startsWith('UPDATE comisiones SET fecha_cumplimiento_plazo')) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) c.fecha_cumplimiento_plazo = p[0];
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'habilitada'")) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) { c.estado = 'habilitada'; c.fecha_habilitacion = p[0]; }
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'programada', fecha_programada_original")) {
      const c = state.comisiones.find((x) => x.id === p[2]);
      if (c) { c.estado = 'programada'; c.fecha_programada_original = p[0]; c.fecha_programada_efectiva = p[1]; }
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ roleIdentity: ri, db }) {
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/comisiones/reevaluar-vencidas', { method: 'POST' }),
    env: { DB: db },
    params: {},
    data: { requestId: 'req-reevaluar-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

test('POST /comisiones/reevaluar-vencidas — un ejecutivo NO puede dispararla (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await reevaluarHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('POST /comisiones/reevaluar-vencidas — admin SÍ puede, y usa la función real sin reimplementarla', async () => {
  const db = fakeDb();
  const response = await reevaluarHandler(fakeContext({ roleIdentity: admin(), db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  // 2 comisiones estaban en 'calculada_provisional' (com-lista, com-sin-pago) — 'com-ya-programada' no se evalúa (ya no está pendiente).
  assert.equal(body.data.evaluadas, 2);
  assert.equal(body.data.habilitadas, 1, 'solo com-lista cumple las 3 condiciones');
});

test('POST /comisiones/reevaluar-vencidas — la comisión que cumple las 3 condiciones queda en "programada" con fechas completadas', async () => {
  const db = fakeDb();
  await reevaluarHandler(fakeContext({ roleIdentity: admin(), db }));
  const c = db._state.comisiones.find((x) => x.id === 'com-lista');
  assert.equal(c.estado, 'programada');
  assert.ok(c.fecha_cumplimiento_plazo, 'el gate debe completar fecha_cumplimiento_plazo solo');
  assert.ok(c.fecha_habilitacion, 'el gate debe completar fecha_habilitacion solo');
  assert.ok(c.fecha_programada_original, 'el gate debe completar fecha_programada_original solo');
  assert.ok(c.fecha_programada_efectiva, 'el gate debe completar fecha_programada_efectiva solo');
});

test('POST /comisiones/reevaluar-vencidas — la comisión SIN pago acreditado queda intacta en "calculada_provisional"', async () => {
  const db = fakeDb();
  await reevaluarHandler(fakeContext({ roleIdentity: admin(), db }));
  const c = db._state.comisiones.find((x) => x.id === 'com-sin-pago');
  assert.equal(c.estado, 'calculada_provisional');
  assert.equal(c.fecha_habilitacion, undefined);
});

test('POST /comisiones/reevaluar-vencidas — una comisión ya "programada" no se toca (no se re-evalúa)', async () => {
  const db = fakeDb();
  const antes = JSON.stringify(db._state.comisiones.find((x) => x.id === 'com-ya-programada'));
  await reevaluarHandler(fakeContext({ roleIdentity: admin(), db }));
  const despues = JSON.stringify(db._state.comisiones.find((x) => x.id === 'com-ya-programada'));
  assert.equal(antes, despues);
});
