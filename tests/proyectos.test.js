// Pruebas de functions/_shared/proyectos.js — RIO-113.
// Cubre el requisito central: en un pack, Landing no puede iniciar hasta
// que Ficha esté aprobada, el segundo pago esté acreditado y los
// materiales de Landing estén completos — las tres a la vez, en cualquier
// orden de llegada. También cubre pagos (informado ≠ acreditado) e
// historial append-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLandingGate, iniciarProduccion, marcarEntregada, aprobarComponente,
  marcarMaterialesCompletos, informarPago, acreditarPago, registrarIncidencia,
  ProyectoError,
} from '../functions/_shared/proyectos.js';

// D1 simulado en memoria — soporta las tablas y consultas reales que usa
// proyectos.js. No es un motor SQL, pero respeta filtros por campo/id.
function fakeDb() {
  const state = {
    ventas: [],
    proyectos: [],
    componentes: [],
    pagos_esperados: [],
    pagos_informados: [],
    acreditaciones: [],
    eventos_historial: [],
    incidencias: [],
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

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6], motivo_nota: p[7], proxima_accion: p[8], responsable_proxima_accion: p[9], created_at: nowIso() });
    } else if (sql.startsWith('UPDATE componentes SET estado_actual')) {
      // El nuevo estado va literal en el SQL (no parametrizado) en algunas
      // llamadas de proyectos.js, ej. "...= 'en_produccion' WHERE id = ?"
      // con un solo bind (el id) — y en otras va parametrizado con 2 binds.
      const literal = sql.match(/estado_actual\s*=\s*'([^']+)'/);
      const nuevoEstado = literal ? literal[1] : p[0];
      const id = literal ? p[0] : p[1];
      const c = state.componentes.find((x) => x.id === id);
      if (c) c.estado_actual = nuevoEstado;
    } else if (sql.startsWith('UPDATE componentes SET materiales_estado')) {
      const literal = sql.match(/materiales_estado\s*=\s*'([^']+)'/);
      const nuevoEstado = literal ? literal[1] : p[0];
      const id = literal ? p[0] : p[1];
      const c = state.componentes.find((x) => x.id === id);
      if (c) c.materiales_estado = nuevoEstado;
    } else if (sql.startsWith('UPDATE proyectos SET estado_actual')) {
      const pr = state.proyectos.find((x) => x.id === p[1]);
      if (pr) pr.estado_actual = p[0];
    } else if (sql.startsWith('INSERT INTO pagos_informados')) {
      state.pagos_informados.push({ id: p[0], pago_esperado_id: p[1], monto_informado: p[2], informado_por: p[3], comprobante_nota: p[4], created_at: nowIso() });
    } else if (sql.startsWith("UPDATE pagos_esperados SET estado = 'informado'")) {
      const pago = state.pagos_esperados.find((x) => x.id === p[0]);
      if (pago) pago.estado = 'informado';
    } else if (sql.startsWith("UPDATE pagos_esperados SET estado = 'acreditado'")) {
      const pago = state.pagos_esperados.find((x) => x.id === p[0]);
      if (pago) pago.estado = 'acreditado';
    } else if (sql.startsWith('INSERT INTO acreditaciones')) {
      state.acreditaciones.push({ id: p[0], pago_informado_id: p[1], monto_acreditado: p[2], verificado_por: p[3], nota: p[4], created_at: nowIso() });
    } else if (sql.startsWith('INSERT INTO incidencias')) {
      state.incidencias.push({ id: p[0], venta_id: p[1], tipo: p[2], motivo: p[3], estado: 'abierta', registrado_por: p[4], created_at: nowIso() });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  function runSelect(sql, p) {
    if (sql.startsWith('SELECT * FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) return state.componentes.filter((c) => c.proyecto_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id') && sql.includes("tipo = 'saldo'")) {
      return state.pagos_esperados.filter((x) => x.venta_id === p[0] && x.tipo === 'saldo');
    }
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((x) => x.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_informados WHERE pago_esperado_id')) {
      return state.pagos_informados.filter((x) => x.pago_esperado_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    throw new Error('consulta inesperada en test: ' + sql);
  }

  function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

// Arma un escenario de pack completo: venta, proyecto, componentes ficha
// (pendiente) + landing (bloqueada), y los dos pagos_esperados.
function seedPack(db, { precio = 90000 } = {}) {
  const ventaId = 'venta-1';
  const proyectoId = 'proyecto-1';
  db._state.ventas.push({ id: ventaId, ejecutivo_email: 'ejecutivo@example.com', mercado: 'CL' });
  db._state.proyectos.push({ id: proyectoId, venta_id: ventaId, estado_actual: 'registrado' });
  db._state.componentes.push({ id: 'comp-ficha', proyecto_id: proyectoId, tipo: 'ficha', estado_actual: 'pendiente', materiales_estado: 'pendiente' });
  db._state.componentes.push({ id: 'comp-landing', proyecto_id: proyectoId, tipo: 'landing', estado_actual: 'bloqueada', materiales_estado: 'pendiente' });
  db._state.pagos_esperados.push({ id: 'pago-inicial', venta_id: ventaId, tipo: 'inicial', monto: precio / 2, estado: 'pendiente' });
  db._state.pagos_esperados.push({ id: 'pago-saldo', venta_id: ventaId, tipo: 'saldo', monto: precio / 2, estado: 'pendiente' });
  return { ventaId, proyectoId };
}

function seedIndividual(db) {
  const ventaId = 'venta-ind';
  const proyectoId = 'proyecto-ind';
  db._state.ventas.push({ id: ventaId, ejecutivo_email: 'ejecutivo@example.com', mercado: 'CL' });
  db._state.proyectos.push({ id: proyectoId, venta_id: ventaId, estado_actual: 'registrado' });
  db._state.componentes.push({ id: 'comp-solo', proyecto_id: proyectoId, tipo: 'ficha', estado_actual: 'pendiente', materiales_estado: 'pendiente' });
  db._state.pagos_esperados.push({ id: 'pago-total', venta_id: ventaId, tipo: 'total', monto: 50000, estado: 'pendiente' });
  return { ventaId, proyectoId };
}

// --- Gate de las 3 condiciones ---

test('evaluateLandingGate() — sin ninguna condición cumplida, informa las 3 faltantes', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  const gate = await evaluateLandingGate(db, 'req-1', ventaId, 'actor@example.com');
  assert.deepEqual(gate.faltantes.sort(), ['ficha_aprobada', 'materiales_landing_completos', 'segundo_pago_acreditado'].sort());
  assert.equal(gate.desbloqueada, false);
});

test('evaluateLandingGate() — con las 3 condiciones cumplidas, desbloquea Landing (pendiente) y registra el evento', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  db._state.componentes.find((c) => c.id === 'comp-ficha').estado_actual = 'aprobada';
  db._state.pagos_esperados.find((p) => p.id === 'pago-saldo').estado = 'acreditado';
  db._state.componentes.find((c) => c.id === 'comp-landing').materiales_estado = 'completos';

  const gate = await evaluateLandingGate(db, 'req-2', ventaId, 'actor@example.com');
  assert.deepEqual(gate.faltantes, []);
  assert.equal(gate.desbloqueada, true);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').estado_actual, 'pendiente');
  assert.ok(db._state.eventos_historial.some((e) => e.entidad_id === 'comp-landing' && e.estado_nuevo === 'pendiente'));
});

test('evaluateLandingGate() — las 3 condiciones NO son secuenciales entre sí: llegan en cualquier orden y el resultado es el mismo', async () => {
  // Orden: materiales primero, luego saldo, luego ficha aprobada al final.
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  db._state.componentes.find((c) => c.id === 'comp-landing').materiales_estado = 'completos';
  let gate = await evaluateLandingGate(db, 'req-3a', ventaId, 'actor@example.com');
  assert.equal(gate.desbloqueada, false);

  db._state.pagos_esperados.find((p) => p.id === 'pago-saldo').estado = 'acreditado';
  gate = await evaluateLandingGate(db, 'req-3b', ventaId, 'actor@example.com');
  assert.equal(gate.desbloqueada, false);

  db._state.componentes.find((c) => c.id === 'comp-ficha').estado_actual = 'aprobada';
  gate = await evaluateLandingGate(db, 'req-3c', ventaId, 'actor@example.com');
  assert.equal(gate.desbloqueada, true);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').estado_actual, 'pendiente');
});

test('evaluateLandingGate() — producto individual (sin componente landing) no aplica', async () => {
  const db = fakeDb();
  const { ventaId } = seedIndividual(db);
  const gate = await evaluateLandingGate(db, 'req-4', ventaId, 'actor@example.com');
  assert.equal(gate.aplica, false);
});

// --- iniciarProduccion() ---

test('iniciarProduccion() — rechaza Landing mientras está bloqueada, e informa exactamente qué falta', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  await assert.rejects(
    () => iniciarProduccion(db, 'req-5', { ventaId, componenteId: 'comp-landing', actorEmail: 'a@example.com' }),
    (e) => {
      assert.ok(e instanceof ProyectoError);
      assert.equal(e.code, 'landing_bloqueada');
      const details = JSON.parse(e.message);
      assert.deepEqual(details.faltantes.sort(), ['ficha_aprobada', 'materiales_landing_completos', 'segundo_pago_acreditado'].sort());
      return true;
    }
  );
});

test('iniciarProduccion() — rechaza si los materiales no están completos, aunque el componente no esté bloqueado', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  await assert.rejects(
    () => iniciarProduccion(db, 'req-6', { ventaId, componenteId: 'comp-ficha', actorEmail: 'a@example.com' }),
    (e) => { assert.equal(e.code, 'materiales_incompletos'); return true; }
  );
});

test('iniciarProduccion() — rechaza si el pago correspondiente (inicial de Ficha) no está acreditado', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  db._state.componentes.find((c) => c.id === 'comp-ficha').materiales_estado = 'completos';
  await assert.rejects(
    () => iniciarProduccion(db, 'req-7', { ventaId, componenteId: 'comp-ficha', actorEmail: 'a@example.com' }),
    (e) => { assert.equal(e.code, 'pago_no_acreditado'); return true; }
  );
});

test('iniciarProduccion() — con materiales completos y pago inicial acreditado, Ficha inicia producción y queda registrado el evento', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  db._state.componentes.find((c) => c.id === 'comp-ficha').materiales_estado = 'completos';
  db._state.pagos_esperados.find((p) => p.id === 'pago-inicial').estado = 'acreditado';

  await iniciarProduccion(db, 'req-8', { ventaId, componenteId: 'comp-ficha', actorEmail: 'a@example.com' });
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-ficha').estado_actual, 'en_produccion');
  assert.ok(db._state.eventos_historial.some((e) => e.entidad_id === 'comp-ficha' && e.estado_nuevo === 'en_produccion'));
});

test('iniciarProduccion() — producto individual solo necesita materiales completos y el pago total acreditado', async () => {
  const db = fakeDb();
  const { ventaId } = seedIndividual(db);
  db._state.componentes.find((c) => c.id === 'comp-solo').materiales_estado = 'completos';
  db._state.pagos_esperados.find((p) => p.id === 'pago-total').estado = 'acreditado';
  await iniciarProduccion(db, 'req-9', { ventaId, componenteId: 'comp-solo', actorEmail: 'a@example.com' });
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-solo').estado_actual, 'en_produccion');
});

// --- Flujo completo Ficha -> entregar -> aprobar -> desbloquea Landing ---

test('flujo completo: Ficha entregada, aprobada, y recién ahí (con saldo y materiales) se desbloquea Landing — nunca antes', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  const ficha = db._state.componentes.find((c) => c.id === 'comp-ficha');
  ficha.materiales_estado = 'completos';
  db._state.pagos_esperados.find((p) => p.id === 'pago-inicial').estado = 'acreditado';

  await iniciarProduccion(db, 'req-10a', { ventaId, componenteId: 'comp-ficha', actorEmail: 'a@example.com' });
  await marcarEntregada(db, 'req-10b', { ventaId, componenteId: 'comp-ficha', actorEmail: 'a@example.com' });
  assert.equal(ficha.estado_actual, 'entregada');

  // Todavía bloqueada: Ficha entregada pero no aprobada.
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').estado_actual, 'bloqueada');

  const { gate } = await aprobarComponente(db, 'req-10c', { ventaId, componenteId: 'comp-ficha', actorEmail: 'a@example.com' });
  assert.equal(ficha.estado_actual, 'aprobada');
  // Todavía bloqueada: falta el saldo acreditado y los materiales de Landing.
  assert.equal(gate.desbloqueada, false);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').estado_actual, 'bloqueada');

  // Ahora se completan las otras dos condiciones.
  const resultMateriales = await marcarMaterialesCompletos(db, 'req-10d', { ventaId, componenteId: 'comp-landing', actorEmail: 'a@example.com' });
  assert.equal(resultMateriales.gate.desbloqueada, false); // todavía falta el saldo.

  db._state.pagos_esperados.find((p) => p.id === 'pago-saldo').estado = 'informado'; // paso intermedio, no cuenta como acreditado.
  let gate2 = await evaluateLandingGate(db, 'req-10e', ventaId, 'actor@example.com');
  assert.equal(gate2.desbloqueada, false);

  db._state.pagos_esperados.find((p) => p.id === 'pago-saldo').estado = 'acreditado';
  gate2 = await evaluateLandingGate(db, 'req-10f', ventaId, 'actor@example.com');
  assert.equal(gate2.desbloqueada, true);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').estado_actual, 'pendiente');
});

test('proyecto pasa a completado solo cuando TODOS sus componentes están aprobados', async () => {
  const db = fakeDb();
  const { ventaId, proyectoId } = seedIndividual(db);
  const comp = db._state.componentes.find((c) => c.id === 'comp-solo');
  comp.materiales_estado = 'completos';
  db._state.pagos_esperados.find((p) => p.id === 'pago-total').estado = 'acreditado';
  await iniciarProduccion(db, 'req-11a', { ventaId, componenteId: 'comp-solo', actorEmail: 'a@example.com' });
  await marcarEntregada(db, 'req-11b', { ventaId, componenteId: 'comp-solo', actorEmail: 'a@example.com' });
  await aprobarComponente(db, 'req-11c', { ventaId, componenteId: 'comp-solo', actorEmail: 'a@example.com' });
  assert.equal(db._state.proyectos.find((p) => p.id === proyectoId).estado_actual, 'completado');
});

// --- Pagos: informado ≠ acreditado ---

test('acreditarPago() — rechaza acreditar un pago que nunca fue informado', async () => {
  const db = fakeDb();
  const { ventaId } = seedIndividual(db);
  await assert.rejects(
    () => acreditarPago(db, 'req-12', { ventaId, pagoId: 'pago-total', montoAcreditado: 50000, actorEmail: 'admin@example.com' }),
    (e) => { assert.equal(e.code, 'sin_informar'); return true; }
  );
});

test('informarPago() luego acreditarPago() — flujo correcto en dos pasos separados', async () => {
  const db = fakeDb();
  const { ventaId } = seedIndividual(db);
  await informarPago(db, 'req-13a', { ventaId, pagoId: 'pago-total', montoInformado: 50000, comprobanteNota: 'transferencia', actorEmail: 'ejecutivo@example.com' });
  assert.equal(db._state.pagos_esperados.find((p) => p.id === 'pago-total').estado, 'informado');

  await acreditarPago(db, 'req-13b', { ventaId, pagoId: 'pago-total', montoAcreditado: 50000, actorEmail: 'admin@example.com' });
  assert.equal(db._state.pagos_esperados.find((p) => p.id === 'pago-total').estado, 'acreditado');
  assert.equal(db._state.acreditaciones.length, 1);
  assert.equal(db._state.acreditaciones[0].verificado_por, 'admin@example.com');
});

test('acreditarPago() — rechaza acreditar dos veces el mismo pago', async () => {
  const db = fakeDb();
  const { ventaId } = seedIndividual(db);
  await informarPago(db, 'req-14a', { ventaId, pagoId: 'pago-total', montoInformado: 50000, actorEmail: 'ejecutivo@example.com' });
  await acreditarPago(db, 'req-14b', { ventaId, pagoId: 'pago-total', montoAcreditado: 50000, actorEmail: 'admin@example.com' });
  await assert.rejects(
    () => acreditarPago(db, 'req-14c', { ventaId, pagoId: 'pago-total', montoAcreditado: 50000, actorEmail: 'admin@example.com' }),
    (e) => { assert.equal(e.code, 'ya_acreditado'); return true; }
  );
});

// --- Historial e incidencias ---

test('registrarIncidencia() — agrega una incidencia y un evento, sin borrar historial previo', async () => {
  const db = fakeDb();
  const { ventaId } = seedIndividual(db);
  await informarPago(db, 'req-15a', { ventaId, pagoId: 'pago-total', montoInformado: 50000, actorEmail: 'ejecutivo@example.com' });
  const eventosAntes = db._state.eventos_historial.length;

  await registrarIncidencia(db, 'req-15b', { ventaId, tipo: 'disputa', motivo: 'Cliente reclama calidad', actorEmail: 'admin@example.com' });

  assert.equal(db._state.incidencias.length, 1);
  assert.equal(db._state.eventos_historial.length, eventosAntes + 1);
  // El evento del pago informado sigue estando — nada se borró.
  assert.ok(db._state.eventos_historial.some((e) => e.entidad === 'pago' && e.estado_nuevo === 'informado'));
});
