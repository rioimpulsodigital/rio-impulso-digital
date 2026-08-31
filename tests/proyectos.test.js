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
  marcarMaterialesInformados, marcarMaterialesCompletos, informarPago, acreditarPago,
  registrarIncidencia, agregarAntecedente, ProyectoError,
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
    comisiones: [], // RIO-114: acreditarPago() ahora también consulta comisiones — ninguna se siembra en este suite (fuera de su alcance), así que siempre vacío.
    asignaciones_realizacion: [], // RIO-115 (consolidación): aprobarComponente() consulta si hay responsable/practicante asignado — ninguno en este suite.
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
    } else if (sql.startsWith('INSERT INTO comisiones')) {
      state.comisiones.push({
        id: p[0], tipo: p[1], rol_realizacion: p[2], venta_id: p[3], componente_id: p[4], beneficiario_email: p[5], plan_id: p[6], asignacion_plan_id: p[7],
        porcentaje_snapshot: p[8], base_snapshot: p[9], monto_base: p[10], moneda: p[11], monto_comision: p[12], estado: 'calculada_provisional',
      });
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
    if (sql.includes('FROM comisiones WHERE venta_id')) return state.comisiones.filter((c) => c.venta_id === p[0]);
    if (sql.startsWith('SELECT usuario_email, rol FROM asignaciones_realizacion WHERE componente_id')) {
      return state.asignaciones_realizacion.filter((a) => a.componente_id === p[0]);
    }
    if (sql.startsWith('SELECT monto FROM costos_directos WHERE componente_id')) {
      return (state.costos_directos || []).filter((c) => c.componente_id === p[0]);
    }
    if (sql.includes('FROM usuarios u') && sql.includes('JOIN asignaciones_plan_comision ap') && sql.includes('JOIN planes_comision pl')) {
      const usuario = (state.usuarios || []).find((u) => u.email === p[0]);
      if (!usuario) return [];
      return (state.asignaciones_plan_comision || [])
        .filter((ap) => ap.usuario_id === usuario.id && !ap.valid_until)
        .map((ap) => ({ asignacion: ap, plan: (state.planes_comision || []).find((pl) => pl.id === ap.plan_id) }))
        .filter((x) => x.plan && x.plan.tipo === p[1] && x.plan.estado === 'activo' && !x.plan.valid_until)
        .map((x) => ({
          asignacion_id: x.asignacion.id, plan_id: x.plan.id, porcentaje: x.plan.porcentaje, base: x.plan.base,
          productos_alcanzados: x.plan.productos_alcanzados, mercados_alcanzados: x.plan.mercados_alcanzados,
          contexto_realizacion: x.plan.contexto_realizacion,
        }));
    }
    if (sql.includes('FROM usuarios u JOIN asignaciones_rol a')) {
      const usuario = (state.usuarios || []).find((u) => u.email === p[0]);
      if (!usuario) return [];
      const asignacion = (state.asignaciones_rol || []).find((a) => a.usuario_id === usuario.id && !a.valid_until);
      return asignacion ? [{ user_status: asignacion.user_status }] : [];
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
  db._state.ventas.push({ id: ventaId, vendedor_email: 'ejecutivo@example.com', mercado: 'CL' });
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
  db._state.ventas.push({ id: ventaId, vendedor_email: 'ejecutivo@example.com', mercado: 'CL' });
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

// --- Realización (RIO-115 consolidación, 31/08/2026): 30% pool, solo o
// responsable+practicante, requiere asignación expresa y usuario activo ---

function seedRealizacionFixtures(db) {
  // aprobarComponente() llama a generarComisionesRealizacionSiCorresponde(),
  // que a su vez resuelve planes vigentes (crearComisionSiCorresponde) y
  // usuarioActivo() — ambos ausentes del fakeDb liviano de este archivo, así
  // que estos escenarios necesitan sembrar las tablas que faltan.
  db._state.usuarios = db._state.usuarios || [];
  db._state.asignaciones_rol = db._state.asignaciones_rol || [];
  db._state.planes_comision = db._state.planes_comision || [];
  db._state.asignaciones_plan_comision = db._state.asignaciones_plan_comision || [];
  db._state.costos_directos = db._state.costos_directos || [];
}

function setProductoVenta(db, ventaId, producto = 'ficha') {
  db._state.ventas.find((v) => v.id === ventaId).producto = producto;
}

function seedUsuarioActivo(db, email, activo = true) {
  const id = db._state.usuarios.length + 1;
  db._state.usuarios.push({ id, email });
  db._state.asignaciones_rol.push({ usuario_id: id, user_status: activo ? 'activo' : 'inactivo', valid_until: null });
  return id;
}

function seedPlanRealizacion(db, { email, porcentaje, contexto }) {
  const usuario = db._state.usuarios.find((u) => u.email === email) || { id: seedUsuarioActivo(db, email) };
  const planId = `plan-realizacion-${contexto}-${porcentaje}-${usuario.id}`;
  db._state.planes_comision.push({
    id: planId, tipo: 'realizacion', contexto_realizacion: contexto, porcentaje, base: 'utilidad_neta_componente',
    productos_alcanzados: JSON.stringify(['ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado']),
    mercados_alcanzados: JSON.stringify(['CL', 'AR']), estado: 'activo', valid_until: null,
  });
  db._state.asignaciones_plan_comision.push({ id: `asig-${planId}`, usuario_id: usuario.id, plan_id: planId, valid_until: null });
}

test('aprobarComponente() — sin asignación de responsable, no genera ninguna comisión de realización (nunca automática)', async () => {
  const db = fakeDb();
  seedRealizacionFixtures(db);
  const { ventaId } = seedIndividual(db);
  db._state.componentes.find((c) => c.id === 'comp-solo').estado_actual = 'entregada';
  await aprobarComponente(db, 'req-real-1', { ventaId, componenteId: 'comp-solo', actorEmail: 'admin@example.com' });
  assert.equal(db._state.comisiones.length, 0);
});

test('aprobarComponente() — responsable sin practicante recibe el 30% completo (contexto "solo")', async () => {
  const db = fakeDb();
  seedRealizacionFixtures(db);
  const { ventaId } = seedIndividual(db);
  setProductoVenta(db, ventaId);
  db._state.componentes.find((c) => c.id === 'comp-solo').estado_actual = 'entregada';
  db._state.componentes.find((c) => c.id === 'comp-solo').precio_atribuido = 50000;
  seedUsuarioActivo(db, 'responsable@example.com');
  seedPlanRealizacion(db, { email: 'responsable@example.com', porcentaje: 30, contexto: 'solo' });
  db._state.asignaciones_realizacion.push({ componente_id: 'comp-solo', usuario_email: 'responsable@example.com', rol: 'responsable' });

  await aprobarComponente(db, 'req-real-2', { ventaId, componenteId: 'comp-solo', actorEmail: 'admin@example.com' });
  assert.equal(db._state.comisiones.length, 1);
  const c = db._state.comisiones[0];
  assert.equal(c.beneficiario_email, 'responsable@example.com');
  assert.equal(c.porcentaje_snapshot, 30);
  assert.equal(c.monto_comision, 15000);
});

test('aprobarComponente() — con practicante, el responsable pasa a 20% y el practicante recibe 10% (dos filas, nunca 30+10)', async () => {
  const db = fakeDb();
  seedRealizacionFixtures(db);
  const { ventaId } = seedIndividual(db);
  setProductoVenta(db, ventaId);
  db._state.componentes.find((c) => c.id === 'comp-solo').estado_actual = 'entregada';
  db._state.componentes.find((c) => c.id === 'comp-solo').precio_atribuido = 50000;
  seedUsuarioActivo(db, 'responsable@example.com');
  seedUsuarioActivo(db, 'practicante@example.com');
  seedPlanRealizacion(db, { email: 'responsable@example.com', porcentaje: 20, contexto: 'responsable_con_practicante' });
  seedPlanRealizacion(db, { email: 'practicante@example.com', porcentaje: 10, contexto: 'practicante' });
  db._state.asignaciones_realizacion.push({ componente_id: 'comp-solo', usuario_email: 'responsable@example.com', rol: 'responsable' });
  db._state.asignaciones_realizacion.push({ componente_id: 'comp-solo', usuario_email: 'practicante@example.com', rol: 'practicante' });

  await aprobarComponente(db, 'req-real-3', { ventaId, componenteId: 'comp-solo', actorEmail: 'admin@example.com' });
  assert.equal(db._state.comisiones.length, 2);
  const responsable = db._state.comisiones.find((c) => c.beneficiario_email === 'responsable@example.com');
  const practicante = db._state.comisiones.find((c) => c.beneficiario_email === 'practicante@example.com');
  assert.equal(responsable.porcentaje_snapshot, 20);
  assert.equal(responsable.monto_comision, 10000);
  assert.equal(practicante.porcentaje_snapshot, 10);
  assert.equal(practicante.monto_comision, 5000);
  assert.equal(responsable.monto_comision + practicante.monto_comision, 15000, 'nunca supera el 30% del componente entre ambos');
});

test('aprobarComponente() — un responsable inactivo no genera su comisión, aunque tenga plan vigente', async () => {
  const db = fakeDb();
  seedRealizacionFixtures(db);
  const { ventaId } = seedIndividual(db);
  db._state.componentes.find((c) => c.id === 'comp-solo').estado_actual = 'entregada';
  seedUsuarioActivo(db, 'responsable@example.com', false);
  seedPlanRealizacion(db, { email: 'responsable@example.com', porcentaje: 30, contexto: 'solo' });
  db._state.asignaciones_realizacion.push({ componente_id: 'comp-solo', usuario_email: 'responsable@example.com', rol: 'responsable' });

  await aprobarComponente(db, 'req-real-4', { ventaId, componenteId: 'comp-solo', actorEmail: 'admin@example.com' });
  assert.equal(db._state.comisiones.length, 0);
});

// --- Historial e incidencias ---

// --- Materiales: informado (dato reportado) ≠ completo (confirmación oficial) ---

test('marcarMaterialesInformados() — pasa de pendiente a informados y registra el evento, sin tocar el gate', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  await marcarMaterialesInformados(db, 'req-16a', { ventaId, componenteId: 'comp-landing', actorEmail: 'vendedor@example.com' });
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').materiales_estado, 'informados');
  assert.ok(db._state.eventos_historial.some((e) => e.entidad_id === 'comp-landing' && e.estado_nuevo === 'materiales:informados'));
  // Landing sigue bloqueada — informar materiales no es lo mismo que confirmarlos completos.
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').estado_actual, 'bloqueada');
});

test('marcarMaterialesInformados() — rechaza informar dos veces (o informar si ya están confirmados completos)', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  await marcarMaterialesInformados(db, 'req-17a', { ventaId, componenteId: 'comp-ficha', actorEmail: 'vendedor@example.com' });
  await assert.rejects(
    () => marcarMaterialesInformados(db, 'req-17b', { ventaId, componenteId: 'comp-ficha', actorEmail: 'vendedor@example.com' }),
    (e) => { assert.equal(e.code, 'materiales_ya_reportados'); return true; }
  );
});

test('marcarMaterialesCompletos() — la confirmación oficial funciona tanto desde "pendiente" como desde "informados"', async () => {
  const db = fakeDb();
  const { ventaId } = seedPack(db);
  // Ficha: confirmación directa sin haber informado antes.
  await marcarMaterialesCompletos(db, 'req-18a', { ventaId, componenteId: 'comp-ficha', actorEmail: 'admin@example.com' });
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-ficha').materiales_estado, 'completos');

  // Landing: primero informados, luego confirmación oficial.
  await marcarMaterialesInformados(db, 'req-18b', { ventaId, componenteId: 'comp-landing', actorEmail: 'vendedor@example.com' });
  await marcarMaterialesCompletos(db, 'req-18c', { ventaId, componenteId: 'comp-landing', actorEmail: 'admin@example.com' });
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').materiales_estado, 'completos');
});

// --- Antecedentes u observaciones ---

test('agregarAntecedente() — agrega un evento de historial sin cambiar ningún estado oficial', async () => {
  const db = fakeDb();
  const { ventaId } = seedIndividual(db);
  const estadoAntes = db._state.componentes.find((c) => c.id === 'comp-solo').estado_actual;
  await agregarAntecedente(db, 'req-19', { ventaId, nota: 'El cliente dijo que le gustó el diseño.', actorEmail: 'vendedor@example.com' });
  assert.ok(db._state.eventos_historial.some((e) => e.entidad === 'venta' && e.estado_nuevo === 'antecedente' && e.motivo_nota === 'El cliente dijo que le gustó el diseño.'));
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-solo').estado_actual, estadoAntes, 'un antecedente nunca debe mover un estado oficial');
});

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
