// Pruebas de functions/_shared/comisiones.js — RIO-114.
// Cubre el requisito central: las 3 condiciones de habilitación (plazo de
// resguardo cumplido, pago total acreditado, venta sin disputa) no son
// secuenciales entre sí — mismo patrón que el gate de Landing en RIO-113 —
// y que llegar a la fecha del calendario nunca por sí sola habilita nada.
// También cubre que un cambio de plan no reescribe una comisión ya
// generada (snapshot inmutable).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generarComisionesParaVenta, evaluateComisionGate, reevaluarComisionesDeVenta,
  procesarPagoAcreditadoParaComisiones, marcarComisionPagada, registrarCostoDirecto,
  calcularFechaProgramada, ComisionError,
} from '../functions/_shared/comisiones.js';

function fakeDb() {
  const state = {
    comisiones: [], planes_comision: [], costos_directos: [], incidencias: [],
    pagos_esperados: [], usuarios: [], asignaciones_rol: [], eventos_historial: [],
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
    if (sql.startsWith('SELECT id, fecha_inicio_plazo, fecha_pago_total_acreditado FROM comisiones WHERE venta_id')) {
      return state.comisiones.filter((c) => c.venta_id === p[0]);
    }
    if (sql.startsWith('SELECT id FROM comisiones WHERE venta_id')) return state.comisiones.filter((c) => c.venta_id === p[0]);
    if (sql.includes('FROM planes_comision')) {
      return state.planes_comision.filter((pl) => pl.tipo === p[0] && pl.producto === p[1] && !pl.valid_until);
    }
    if (sql.startsWith('SELECT monto FROM costos_directos WHERE componente_id')) {
      return state.costos_directos.filter((c) => c.componente_id === p[0]);
    }
    if (sql.startsWith("SELECT id FROM incidencias WHERE venta_id")) {
      return state.incidencias.filter((i) => i.venta_id === p[0] && i.estado === 'abierta');
    }
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((pg) => pg.venta_id === p[0]);
    if (sql.includes('FROM usuarios u JOIN asignaciones_rol a')) return [];
    throw new Error('consulta inesperada en test: ' + sql);
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO comisiones')) {
      state.comisiones.push({
        id: p[0], tipo: p[1], venta_id: p[2], componente_id: p[3], beneficiario_email: p[4], plan_id: p[5],
        porcentaje_snapshot: p[6], base_snapshot: p[7], monto_base: p[8], moneda: p[9], monto_comision: p[10],
        estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_cumplimiento_plazo: null,
        fecha_pago_total_acreditado: null, fecha_habilitacion: null, fecha_programada_original: null,
        fecha_programada_efectiva: null, fecha_pago_real: null,
      });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_nuevo: p[5] });
    } else if (sql.startsWith('INSERT INTO costos_directos')) {
      state.costos_directos.push({ id: p[0], componente_id: p[1], tipo: p[2], monto: p[3], moneda: p[4], autorizado_por: p[5], nota: p[6] });
    } else if (sql.startsWith('UPDATE comisiones SET fecha_inicio_plazo')) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) c.fecha_inicio_plazo = p[0];
    } else if (sql.startsWith('UPDATE comisiones SET fecha_pago_total_acreditado')) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) c.fecha_pago_total_acreditado = p[0];
    } else if (sql.startsWith('UPDATE comisiones SET fecha_cumplimiento_plazo')) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) c.fecha_cumplimiento_plazo = p[0];
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'habilitada'")) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) { c.estado = 'habilitada'; c.fecha_habilitacion = p[0]; }
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'programada'")) {
      const c = state.comisiones.find((x) => x.id === p[2]);
      if (c) { c.estado = 'programada'; c.fecha_programada_original = p[0]; c.fecha_programada_efectiva = p[1]; }
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'pagada'")) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) { c.estado = 'pagada'; c.fecha_pago_real = p[0]; }
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function seedPlan(db, { tipo = 'comercial', producto = 'ficha', porcentaje = 40 } = {}) {
  db._state.planes_comision.push({ id: `plan-${tipo}-${producto}`, tipo, producto, porcentaje, base: 'utilidad_neta_venta', valid_until: null });
}

// --- calcularFechaProgramada() — calendario 26→10/11→25 ---

test('calcularFechaProgramada() — habilitada el 26 o después programa el 25 del mes siguiente', () => {
  // 25/02/2026 es miércoles — caso sin ajuste de fin de semana (eso se prueba aparte).
  assert.equal(calcularFechaProgramada('2026-01-26 10:00:00'), '2026-02-25');
  assert.equal(calcularFechaProgramada('2026-01-31 10:00:00'), '2026-02-25');
});

test('calcularFechaProgramada() — habilitada del 1 al 10 programa el 25 del mismo mes', () => {
  assert.equal(calcularFechaProgramada('2026-02-01 10:00:00'), '2026-02-25');
  assert.equal(calcularFechaProgramada('2026-02-10 10:00:00'), '2026-02-25');
});

test('calcularFechaProgramada() — habilitada del 11 al 25 programa el 10 del mes siguiente', () => {
  // 10/02/2026 es martes — caso sin ajuste de fin de semana.
  assert.equal(calcularFechaProgramada('2026-01-11 10:00:00'), '2026-02-10');
  assert.equal(calcularFechaProgramada('2026-01-25 10:00:00'), '2026-02-10');
});

test('calcularFechaProgramada() — si la fecha calculada cae sábado, se adelanta al viernes anterior', () => {
  // 25/04/2026 es sábado.
  assert.equal(calcularFechaProgramada('2026-03-26 10:00:00'), '2026-04-24');
});

test('calcularFechaProgramada() — si la fecha calculada cae domingo, se adelanta al viernes anterior', () => {
  // 10/05/2026 es domingo.
  assert.equal(calcularFechaProgramada('2026-04-11 10:00:00'), '2026-05-08');
});

// --- Gate de habilitación: 3 condiciones no secuenciales ---

test('evaluateComisionGate() — sin plazo iniciado ni pago acreditado, informa ambas faltantes (sin disputa registrada, esa condición ya está cumplida por defecto)', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });
  const gate = await evaluateComisionGate(db, 'req-1', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);
  assert.deepEqual(gate.faltantes.sort(), ['pago_total_acreditado', 'plazo_resguardo_iniciado'].sort());
});

test('evaluateComisionGate() — plazo iniciado pero no cumplido (menos de 10 días corridos) sigue bloqueada', async () => {
  const db = fakeDb();
  const ayer = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: ayer, fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });
  const gate = await evaluateComisionGate(db, 'req-2', 'c1', 'actor@example.com');
  assert.ok(gate.faltantes.includes('plazo_resguardo_cumplido'));
});

test('evaluateComisionGate() — las 3 condiciones llegan en cualquier orden y el resultado final es el mismo: habilitada y programada', async () => {
  const db = fakeDb();
  const hace11dias = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });

  // Orden: primero sin disputa (ya lo está por defecto — sin incidencias), luego pago, luego plazo.
  let gate = await evaluateComisionGate(db, 'req-3a', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);

  db._state.comisiones.find((c) => c.id === 'c1').fecha_pago_total_acreditado = new Date().toISOString().replace('T', ' ').slice(0, 19);
  gate = await evaluateComisionGate(db, 'req-3b', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);

  db._state.comisiones.find((c) => c.id === 'c1').fecha_inicio_plazo = hace11dias;
  gate = await evaluateComisionGate(db, 'req-3c', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, true);
  assert.equal(db._state.comisiones.find((c) => c.id === 'c1').estado, 'programada');
  assert.ok(db._state.comisiones.find((c) => c.id === 'c1').fecha_programada_original);
});

test('evaluateComisionGate() — una disputa abierta bloquea aunque el plazo y el pago ya estén cumplidos', async () => {
  const db = fakeDb();
  const hace11dias = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: hace11dias, fecha_pago_total_acreditado: new Date().toISOString(), fecha_cumplimiento_plazo: null });
  db._state.incidencias.push({ venta_id: 'v1', estado: 'abierta' });
  const gate = await evaluateComisionGate(db, 'req-4', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);
  assert.deepEqual(gate.faltantes, ['venta_sin_disputa']);
});

test('llegar a la fecha del calendario NO habilita nada por sí sola — solo las 3 condiciones reales lo hacen (criterio de aceptación de RIO-114)', async () => {
  const db = fakeDb();
  // Ninguna condición cumplida — sin importar qué día sea hoy en el calendario 26→10/11→25.
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });
  const gate = await evaluateComisionGate(db, 'req-5', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);
  assert.equal(db._state.comisiones.find((c) => c.id === 'c1').estado, 'calculada_provisional');
});

// --- generarComisionesParaVenta() ---

test('generarComisionesParaVenta() — con tasa vigente, calcula el monto sobre la utilidad neta (precio atribuido menos costos directos)', async () => {
  const db = fakeDb();
  seedPlan(db, { tipo: 'comercial', producto: 'ficha', porcentaje: 40 });
  db._state.costos_directos.push({ componente_id: 'comp-1', monto: 5000 });

  const ids = await generarComisionesParaVenta(db, 'req-6', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(ids.length, 1);
  const c = db._state.comisiones[0];
  assert.equal(c.monto_base, 45000); // 50000 - 5000 de costo directo.
  assert.equal(c.monto_comision, 18000); // 40% de 45000.
});

test('generarComisionesParaVenta() — sin tasa vigente, genera la comisión visible pero sin porcentaje inventado', async () => {
  const db = fakeDb();
  await generarComisionesParaVenta(db, 'req-7', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(db._state.comisiones[0].porcentaje_snapshot, null);
  assert.equal(db._state.comisiones[0].monto_comision, null);
});

test('un cambio de plan (tasa nueva) NO reescribe una comisión ya generada — snapshot inmutable', async () => {
  const db = fakeDb();
  seedPlan(db, { tipo: 'comercial', producto: 'ficha', porcentaje: 40 });
  await generarComisionesParaVenta(db, 'req-8a', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  const comisionOriginal = db._state.comisiones[0];
  assert.equal(comisionOriginal.porcentaje_snapshot, 40);

  // Brenda cambia la tasa general a 35% (nueva fila vigente, sin tocar la anterior).
  db._state.planes_comision[0].valid_until = '2026-09-01 00:00:00';
  seedPlan(db, { tipo: 'comercial', producto: 'ficha', porcentaje: 35 });

  // La comisión ya generada no cambia — nadie la recalcula hacia atrás.
  assert.equal(comisionOriginal.porcentaje_snapshot, 40, 'el cambio de plan no debe alterar una comisión ya calculada');

  // Una venta NUEVA sí usa la tasa nueva.
  await generarComisionesParaVenta(db, 'req-8b', {
    ventaId: 'v2', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-2', precio_atribuido: 50000 }],
  });
  const comisionNueva = db._state.comisiones.find((c) => c.venta_id === 'v2');
  assert.equal(comisionNueva.porcentaje_snapshot, 35);
});

// --- procesarPagoAcreditadoParaComisiones() ---

test('procesarPagoAcreditadoParaComisiones() — el primer pago acreditado (individual) inicia el plazo de resguardo', async () => {
  const db = fakeDb();
  db._state.pagos_esperados.push({ venta_id: 'v1', tipo: 'total', estado: 'acreditado' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null });
  await procesarPagoAcreditadoParaComisiones(db, 'req-9', { ventaId: 'v1', pagoTipo: 'total', actorEmail: 'admin@example.com' });
  const c = db._state.comisiones.find((x) => x.id === 'c1');
  assert.ok(c.fecha_inicio_plazo);
  assert.ok(c.fecha_pago_total_acreditado, 'en un producto individual, el único pago también es el pago total');
});

test('procesarPagoAcreditadoParaComisiones() — en un pack, el pago inicial NO marca pago total acreditado hasta que el saldo también lo esté', async () => {
  const db = fakeDb();
  db._state.pagos_esperados.push({ venta_id: 'v1', tipo: 'inicial', estado: 'acreditado' });
  db._state.pagos_esperados.push({ venta_id: 'v1', tipo: 'saldo', estado: 'pendiente' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null });
  await procesarPagoAcreditadoParaComisiones(db, 'req-10', { ventaId: 'v1', pagoTipo: 'inicial', actorEmail: 'admin@example.com' });
  const c = db._state.comisiones.find((x) => x.id === 'c1');
  assert.ok(c.fecha_inicio_plazo, 'el inicial SÍ es el primer pago del pack');
  assert.equal(c.fecha_pago_total_acreditado, null, 'el saldo todavía está pendiente');
});

// --- marcarComisionPagada() ---

test('marcarComisionPagada() — rechaza pagar una comisión que no está programada', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional' });
  await assert.rejects(
    () => marcarComisionPagada(db, 'req-11', { comisionId: 'c1', actorEmail: 'admin@example.com' }),
    (e) => { assert.ok(e instanceof ComisionError); assert.equal(e.code, 'transicion_invalida'); return true; }
  );
});

test('marcarComisionPagada() — marca como pagada una comisión programada', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'programada' });
  await marcarComisionPagada(db, 'req-12', { comisionId: 'c1', actorEmail: 'admin@example.com' });
  assert.equal(db._state.comisiones.find((c) => c.id === 'c1').estado, 'pagada');
});

// --- registrarCostoDirecto() ---

test('registrarCostoDirecto() — queda registrado con quien lo autorizó, de forma auditable', async () => {
  const db = fakeDb();
  const id = await registrarCostoDirecto(db, 'req-13', { componenteId: 'comp-1', tipo: 'dominio_propio', monto: 15000, moneda: 'CLP', autorizadoPor: 'admin@example.com' });
  assert.ok(id);
  assert.equal(db._state.costos_directos[0].autorizado_por, 'admin@example.com');
  assert.equal(db._state.costos_directos[0].monto, 15000);
});
