// Pruebas de functions/_shared/comisiones.js — RIO-114, actualizadas para
// las decisiones definitivas de Brenda del 28/08/2026 (planes versionados
// por asignación, calendario con feriados configurables, retención por
// disputa, comisión de producción con asignación expresa).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generarComisionesParaVenta, generarComisionProduccionSiCorresponde, evaluateComisionGate,
  reevaluarComisionesDeVenta, retenerComisionesPorDisputa, procesarPagoAcreditadoParaComisiones,
  marcarComisionPagada, registrarCostoDirecto, registrarCostoMedioPago, calcularFechaProgramada, ComisionError,
} from '../functions/_shared/comisiones.js';

function fakeDb() {
  const state = {
    ventas: [], proyectos: [], componentes: [],
    comisiones: [], planes_comision: [], asignaciones_plan_comision: [], asignaciones_produccion: [],
    costos_directos: [], incidencias: [], pagos_esperados: [], usuarios: [], asignaciones_rol: [],
    dias_no_habiles: [], eventos_historial: [],
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
    if (sql.startsWith("SELECT id, estado FROM comisiones WHERE venta_id")) {
      return state.comisiones.filter((c) => c.venta_id === p[0] && ['habilitada', 'programada'].includes(c.estado));
    }
    if (sql.startsWith('SELECT id FROM comisiones WHERE venta_id')) return state.comisiones.filter((c) => c.venta_id === p[0]);
    if (sql.includes('FROM usuarios u') && sql.includes('JOIN asignaciones_plan_comision ap') && sql.includes('JOIN planes_comision pl')) {
      const usuario = state.usuarios.find((u) => u.email === p[0]);
      if (!usuario) return [];
      return state.asignaciones_plan_comision
        .filter((ap) => ap.usuario_id === usuario.id && !ap.valid_until && (!ap.valid_from || ap.valid_from <= new Date().toISOString().replace('T', ' ').slice(0, 19)))
        .map((ap) => ({ asignacion: ap, plan: state.planes_comision.find((pl) => pl.id === ap.plan_id) }))
        .filter((x) => x.plan && x.plan.tipo === p[1] && x.plan.estado === 'activo' && !x.plan.valid_until)
        .map((x) => ({
          asignacion_id: x.asignacion.id, plan_id: x.plan.id, porcentaje: x.plan.porcentaje, base: x.plan.base,
          productos_alcanzados: x.plan.productos_alcanzados, mercados_alcanzados: x.plan.mercados_alcanzados,
        }));
    }
    if (sql.includes('FROM usuarios u JOIN asignaciones_rol a') && sql.includes("role = 'supervisor'")) {
      return state.usuarios
        .map((u) => ({ u, a: state.asignaciones_rol.find((a) => a.usuario_id === u.id && a.role === 'supervisor' && !a.valid_until) }))
        .filter((x) => x.a)
        .map((x) => ({ email: x.u.email, allowed_markets: x.a.allowed_markets }));
    }
    if (sql.includes('FROM usuarios u JOIN asignaciones_rol a')) {
      // usuarioActivo(): sin filtrar por rol, cualquier asignación vigente.
      const usuario = state.usuarios.find((u) => u.email === p[0]);
      if (!usuario) return [];
      const asignacion = state.asignaciones_rol.find((a) => a.usuario_id === usuario.id && !a.valid_until);
      return asignacion ? [{ user_status: asignacion.user_status }] : [];
    }
    if (sql.startsWith('SELECT monto FROM costos_directos WHERE componente_id')) {
      return state.costos_directos.filter((c) => c.componente_id === p[0]);
    }
    if (sql.startsWith('SELECT usuario_email FROM asignaciones_produccion WHERE componente_id')) {
      return state.asignaciones_produccion.filter((a) => a.componente_id === p[0]);
    }
    if (sql.startsWith('SELECT id FROM incidencias WHERE venta_id')) {
      return state.incidencias.filter((i) => i.venta_id === p[0] && i.estado === 'abierta');
    }
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((pg) => pg.venta_id === p[0]);
    if (sql.startsWith('SELECT mercado FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT 1 AS x FROM dias_no_habiles')) {
      return state.dias_no_habiles.filter((d) => d.mercado === p[0] && d.fecha === p[1]);
    }
    if (sql.startsWith('SELECT id FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT id, precio_atribuido FROM componentes WHERE proyecto_id')) {
      return state.componentes.filter((c) => c.proyecto_id === p[0]);
    }
    throw new Error('consulta inesperada en test: ' + sql);
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO comisiones')) {
      state.comisiones.push({
        id: p[0], tipo: p[1], venta_id: p[2], componente_id: p[3], beneficiario_email: p[4], plan_id: p[5], asignacion_plan_id: p[6],
        porcentaje_snapshot: p[7], base_snapshot: p[8], monto_base: p[9], moneda: p[10], monto_comision: p[11],
        estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_cumplimiento_plazo: null,
        fecha_pago_total_acreditado: null, fecha_habilitacion: null, fecha_programada_original: null,
        fecha_programada_efectiva: null, fecha_pago_real: null, motivo_retencion_o_reprogramacion: null,
      });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5] });
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
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'programada', fecha_programada_efectiva")) {
      const c = state.comisiones.find((x) => x.id === p[2]);
      if (c) { c.estado = 'programada'; c.fecha_programada_efectiva = p[0]; c.motivo_retencion_o_reprogramacion = p[1]; }
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'programada'")) {
      const c = state.comisiones.find((x) => x.id === p[2]);
      if (c) { c.estado = 'programada'; c.fecha_programada_original = p[0]; c.fecha_programada_efectiva = p[1]; }
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'retenida'")) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) { c.estado = 'retenida'; c.motivo_retencion_o_reprogramacion = p[0]; }
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'pagada'")) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) { c.estado = 'pagada'; c.fecha_pago_real = p[0]; }
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

let nextUsuarioId = 1;
function seedAsignacionPlan(db, { email, tipo, porcentaje, base, productos = ['ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado'], mercados = ['CL', 'AR'], planEstado = 'activo', planValidUntil = null, asignacionValidUntil = null } = {}) {
  let usuario = db._state.usuarios.find((u) => u.email === email);
  if (!usuario) {
    usuario = { id: nextUsuarioId++, email };
    db._state.usuarios.push(usuario);
  }
  const planId = `plan-${tipo}-${porcentaje}-${usuario.id}-${db._state.planes_comision.length}`;
  db._state.planes_comision.push({
    id: planId, tipo, porcentaje, base: base || (tipo === 'produccion' ? 'utilidad_neta_componente' : 'utilidad_neta_venta'),
    productos_alcanzados: JSON.stringify(productos), mercados_alcanzados: JSON.stringify(mercados), estado: planEstado, valid_until: planValidUntil,
  });
  db._state.asignaciones_plan_comision.push({ id: `asig-${planId}`, usuario_id: usuario.id, plan_id: planId, valid_until: asignacionValidUntil });
  return usuario.id;
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// --- calcularFechaProgramada() — calendario 26→10/11→25 + feriados configurables ---

test('calcularFechaProgramada() — habilitada el 26 o después programa el 25 del mes siguiente', async () => {
  const db = fakeDb();
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-01-26 10:00:00', 'CL'), '2026-02-25');
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-01-31 10:00:00', 'CL'), '2026-02-25');
});

test('calcularFechaProgramada() — habilitada del 1 al 10 programa el 25 del mismo mes', async () => {
  const db = fakeDb();
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-02-01 10:00:00', 'CL'), '2026-02-25');
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-02-10 10:00:00', 'CL'), '2026-02-25');
});

test('calcularFechaProgramada() — habilitada del 11 al 25 programa el 10 del mes siguiente', async () => {
  const db = fakeDb();
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-01-11 10:00:00', 'CL'), '2026-02-10');
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-01-25 10:00:00', 'CL'), '2026-02-10');
});

test('calcularFechaProgramada() — si la fecha calculada cae sábado, se adelanta al viernes anterior', async () => {
  const db = fakeDb();
  // 25/04/2026 es sábado.
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-03-26 10:00:00', 'CL'), '2026-04-24');
});

test('calcularFechaProgramada() — si la fecha calculada cae domingo, se adelanta al viernes anterior', async () => {
  const db = fakeDb();
  // 10/05/2026 es domingo.
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-04-11 10:00:00', 'CL'), '2026-05-08');
});

test('calcularFechaProgramada() — un feriado configurado en el mercado también adelanta la fecha', async () => {
  const db = fakeDb();
  // 10/02/2026 es martes (día hábil normal) — se marca como feriado de CL.
  db._state.dias_no_habiles.push({ mercado: 'CL', fecha: '2026-02-10', motivo: 'Feriado de prueba' });
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-01-11 10:00:00', 'CL'), '2026-02-09', 'con el 10 feriado, se adelanta al lunes 9');
});

test('calcularFechaProgramada() — varios días no hábiles consecutivos se saltan todos', async () => {
  const db = fakeDb();
  // 25/02/2026 es miércoles. Se marcan miércoles, martes y lunes como no hábiles -> debe caer en el viernes 20.
  db._state.dias_no_habiles.push({ mercado: 'CL', fecha: '2026-02-25', motivo: 'Feriado 1' });
  db._state.dias_no_habiles.push({ mercado: 'CL', fecha: '2026-02-24', motivo: 'Feriado 2' });
  db._state.dias_no_habiles.push({ mercado: 'CL', fecha: '2026-02-23', motivo: 'Feriado 3' });
  // 22/02/2026 es domingo (ya cubierto por el ajuste de fin de semana).
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-01-26 10:00:00', 'CL'), '2026-02-20');
});

test('calcularFechaProgramada() — el mismo feriado en AR no afecta a CL (el calendario es por mercado)', async () => {
  const db = fakeDb();
  db._state.dias_no_habiles.push({ mercado: 'AR', fecha: '2026-02-10', motivo: 'Feriado de Argentina' });
  assert.equal(await calcularFechaProgramada(db, 'req', '2026-01-11 10:00:00', 'CL'), '2026-02-10', 'CL no tiene ese feriado — sin ajuste');
});

// --- Gate de habilitación: 3 condiciones no secuenciales ---

test('evaluateComisionGate() — sin plazo iniciado ni pago acreditado, informa ambas faltantes (sin disputa registrada, esa condición ya está cumplida por defecto)', async () => {
  const db = fakeDb();
  db._state.ventas.push({ id: 'v1', mercado: 'CL' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });
  const gate = await evaluateComisionGate(db, 'req-1', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);
  assert.deepEqual(gate.faltantes.sort(), ['pago_total_acreditado', 'plazo_resguardo_iniciado'].sort());
});

test('evaluateComisionGate() — plazo iniciado pero no cumplido (menos de 10 días corridos) sigue bloqueada', async () => {
  const db = fakeDb();
  db._state.ventas.push({ id: 'v1', mercado: 'CL' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: isoDaysAgo(2), fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });
  const gate = await evaluateComisionGate(db, 'req-2', 'c1', 'actor@example.com');
  assert.ok(gate.faltantes.includes('plazo_resguardo_cumplido'));
});

test('evaluateComisionGate() — las 3 condiciones llegan en cualquier orden y el resultado final es el mismo: habilitada y programada', async () => {
  const db = fakeDb();
  db._state.ventas.push({ id: 'v1', mercado: 'CL' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });

  let gate = await evaluateComisionGate(db, 'req-3a', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);

  db._state.comisiones.find((c) => c.id === 'c1').fecha_pago_total_acreditado = isoDaysAgo(0);
  gate = await evaluateComisionGate(db, 'req-3b', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);

  db._state.comisiones.find((c) => c.id === 'c1').fecha_inicio_plazo = isoDaysAgo(11);
  gate = await evaluateComisionGate(db, 'req-3c', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, true);
  assert.equal(db._state.comisiones.find((c) => c.id === 'c1').estado, 'programada');
  assert.ok(db._state.comisiones.find((c) => c.id === 'c1').fecha_programada_original);
});

test('evaluateComisionGate() — una disputa abierta bloquea aunque el plazo y el pago ya estén cumplidos', async () => {
  const db = fakeDb();
  db._state.ventas.push({ id: 'v1', mercado: 'CL' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: isoDaysAgo(11), fecha_pago_total_acreditado: isoDaysAgo(0), fecha_cumplimiento_plazo: null });
  db._state.incidencias.push({ venta_id: 'v1', estado: 'abierta' });
  const gate = await evaluateComisionGate(db, 'req-4', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);
  assert.deepEqual(gate.faltantes, ['venta_sin_disputa']);
});

test('llegar a la fecha del calendario NO habilita nada por sí sola — solo las 3 condiciones reales lo hacen (criterio de aceptación de RIO-114)', async () => {
  const db = fakeDb();
  db._state.ventas.push({ id: 'v1', mercado: 'CL' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null, fecha_cumplimiento_plazo: null });
  const gate = await evaluateComisionGate(db, 'req-5', 'c1', 'actor@example.com');
  assert.equal(gate.habilitada, false);
  assert.equal(db._state.comisiones.find((c) => c.id === 'c1').estado, 'calculada_provisional');
});

// --- Retención por disputa (nunca desaparece, queda con historial) ---

test('retenerComisionesPorDisputa() — retiene una comisión programada, sin borrarla, y queda en el historial', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'programada' });
  await retenerComisionesPorDisputa(db, 'req-6', { ventaId: 'v1', actorEmail: 'admin@example.com', motivo: 'Disputa del cliente' });
  const c = db._state.comisiones.find((x) => x.id === 'c1');
  assert.equal(c.estado, 'retenida');
  assert.equal(c.motivo_retencion_o_reprogramacion, 'Disputa del cliente');
  assert.ok(db._state.eventos_historial.some((e) => e.entidad_id === 'c1' && e.estado_nuevo === 'retenida'));
});

test('retenerComisionesPorDisputa() — nunca toca una comisión ya pagada (terminal)', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'pagada' });
  await retenerComisionesPorDisputa(db, 'req-7', { ventaId: 'v1', actorEmail: 'admin@example.com', motivo: 'Disputa tardía' });
  assert.equal(db._state.comisiones.find((c) => c.id === 'c1').estado, 'pagada');
});

test('una comisión retenida vuelve a habilitarse y se reprograma cuando la disputa se resuelve — conserva la fecha programada original', async () => {
  const db = fakeDb();
  db._state.ventas.push({ id: 'v1', mercado: 'CL' });
  db._state.comisiones.push({
    id: 'c1', venta_id: 'v1', estado: 'retenida', fecha_inicio_plazo: isoDaysAgo(20), fecha_pago_total_acreditado: isoDaysAgo(15),
    fecha_programada_original: '2026-01-10', fecha_programada_efectiva: '2026-01-10',
  });
  // La disputa ya se resolvió — sin incidencias abiertas.
  const gate = await evaluateComisionGate(db, 'req-8', 'c1', 'admin@example.com');
  assert.equal(gate.habilitada, true);
  const c = db._state.comisiones.find((x) => x.id === 'c1');
  assert.equal(c.estado, 'programada');
  assert.equal(c.fecha_programada_original, '2026-01-10', 'la fecha original nunca se sobrescribe');
  assert.notEqual(c.fecha_programada_efectiva, '2026-01-10', 'la fecha efectiva sí se recalcula');
  assert.ok(c.motivo_retencion_o_reprogramacion);
});

// --- generarComisionesParaVenta() ---

test('generarComisionesParaVenta() — con plan vigente, calcula el monto sobre la utilidad neta (precio atribuido menos costos directos)', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor@example.com', tipo: 'comercial', porcentaje: 40 });
  db._state.costos_directos.push({ componente_id: 'comp-1', monto: 5000 });

  const ids = await generarComisionesParaVenta(db, 'req-9', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(ids.length, 1);
  const c = db._state.comisiones[0];
  assert.equal(c.monto_base, 45000); // 50000 - 5000 de costo directo.
  assert.equal(c.monto_comision, 18000); // 40% de 45000.
});

test('generarComisionesParaVenta() — un vendedor sin plan activo no genera ninguna fila (comisión 0%, nunca inventada)', async () => {
  const db = fakeDb();
  const ids = await generarComisionesParaVenta(db, 'req-10', {
    ventaId: 'v1', vendedorEmail: 'vendedor.sin.plan@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(ids.length, 0);
  assert.equal(db._state.comisiones.length, 0);
});

test('generarComisionesParaVenta() — un plan con estado inactivo no genera comisión, aunque la asignación esté vigente', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor@example.com', tipo: 'comercial', porcentaje: 40, planEstado: 'inactivo' });
  const ids = await generarComisionesParaVenta(db, 'req-11', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(ids.length, 0);
});

test('generarComisionesParaVenta() — un plan ya vencido (valid_until pasado) no aplica', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor@example.com', tipo: 'comercial', porcentaje: 40, planValidUntil: '2020-01-01 00:00:00' });
  const ids = await generarComisionesParaVenta(db, 'req-12', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(ids.length, 0);
});

test('generarComisionesParaVenta() — una asignación cuya vigencia empieza en el futuro todavía no aplica', async () => {
  const db = fakeDb();
  const usuarioId = seedAsignacionPlan(db, { email: 'vendedor.futuro@example.com', tipo: 'comercial', porcentaje: 40 });
  // Sobrescribe valid_from de la asignación recién creada a una fecha futura.
  db._state.asignaciones_plan_comision[db._state.asignaciones_plan_comision.length - 1].valid_from = '2099-01-01 00:00:00';
  const ids = await generarComisionesParaVenta(db, 'req-12b', {
    ventaId: 'v1', vendedorEmail: 'vendedor.futuro@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(ids.length, 0, 'una asignación que todavía no empezó no debe aplicarse hoy');
});

test('generarComisionesParaVenta() — una asignación ya cerrada (valid_until pasado) tampoco aplica, aunque el plan siga vigente', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor@example.com', tipo: 'comercial', porcentaje: 40, asignacionValidUntil: '2020-01-01 00:00:00' });
  const ids = await generarComisionesParaVenta(db, 'req-13', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  assert.equal(ids.length, 0);
});

test('un cambio de plan (nueva versión) NO reescribe una comisión ya generada — snapshot inmutable, sin retroactividad', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor@example.com', tipo: 'comercial', porcentaje: 40 });
  await generarComisionesParaVenta(db, 'req-14a', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  const comisionOriginal = db._state.comisiones[0];
  assert.equal(comisionOriginal.porcentaje_snapshot, 40);

  // Brenda cierra el plan anterior y asigna uno nuevo al 35%.
  db._state.planes_comision[0].valid_until = '2026-09-01 00:00:00';
  seedAsignacionPlan(db, { email: 'vendedor@example.com', tipo: 'comercial', porcentaje: 35 });

  assert.equal(comisionOriginal.porcentaje_snapshot, 40, 'el cambio de plan no debe alterar una comisión ya calculada');

  await generarComisionesParaVenta(db, 'req-14b', {
    ventaId: 'v2', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-2', precio_atribuido: 50000 }],
  });
  const comisionNueva = db._state.comisiones.find((c) => c.venta_id === 'v2');
  assert.equal(comisionNueva.porcentaje_snapshot, 35);
});

test('generarComisionesParaVenta() — supervisión 10% se genera en CLP para una venta de CL', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor@example.com', tipo: 'comercial', porcentaje: 40 });
  const supId = seedAsignacionPlan(db, { email: 'supervisor@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: supId, role: 'supervisor', allowed_markets: '["CL"]', valid_until: null });

  await generarComisionesParaVenta(db, 'req-15', {
    ventaId: 'v1', vendedorEmail: 'vendedor@example.com', mercado: 'CL', producto: 'ficha', moneda: 'CLP',
    componentes: [{ id: 'comp-1', precio_atribuido: 50000 }],
  });
  const sup = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.equal(sup.moneda, 'CLP');
  assert.equal(sup.monto_comision, 5000);
});

test('generarComisionesParaVenta() — supervisión 10% se genera en ARS para una venta de AR, nunca convertida', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor.ar@example.com', tipo: 'comercial', porcentaje: 40 });
  const supId = seedAsignacionPlan(db, { email: 'supervisor.ar@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: supId, role: 'supervisor', allowed_markets: '["AR"]', valid_until: null });

  await generarComisionesParaVenta(db, 'req-16', {
    ventaId: 'v1', vendedorEmail: 'vendedor.ar@example.com', mercado: 'AR', producto: 'ficha', moneda: 'ARS',
    componentes: [{ id: 'comp-1', precio_atribuido: 125000 }],
  });
  const sup = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.equal(sup.moneda, 'ARS');
});

// --- Comisión de producción ---

test('generarComisionProduccionSiCorresponde() — sin asignación expresa, no genera nada', async () => {
  const db = fakeDb();
  const id = await generarComisionProduccionSiCorresponde(db, 'req-17', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.equal(id, null);
});

test('generarComisionProduccionSiCorresponde() — con asignación y plan vigentes, y el asistente activo, genera el 10% sobre la utilidad del componente', async () => {
  const db = fakeDb();
  const asistenteId = seedAsignacionPlan(db, { email: 'asistente@example.com', tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: asistenteId, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-1', usuario_email: 'asistente@example.com' });

  const id = await generarComisionProduccionSiCorresponde(db, 'req-18', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.ok(id);
  const c = db._state.comisiones.find((x) => x.id === id);
  assert.equal(c.tipo, 'produccion');
  assert.equal(c.beneficiario_email, 'asistente@example.com');
  assert.equal(c.monto_comision, 5000);
});

test('generarComisionProduccionSiCorresponde() — un asistente inactivo (dado de baja) no genera comisión, aunque siga asignado', async () => {
  const db = fakeDb();
  const asistenteId = seedAsignacionPlan(db, { email: 'asistente.baja@example.com', tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: asistenteId, role: 'asistente', user_status: 'inactivo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-1', usuario_email: 'asistente.baja@example.com' });

  const id = await generarComisionProduccionSiCorresponde(db, 'req-19', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.equal(id, null);
});

test('generarComisionProduccionSiCorresponde() — una asignación creada DESPUÉS de llamar esta función no genera nada retroactivamente (se llama una sola vez, al aprobar)', async () => {
  const db = fakeDb();
  // Al momento de "aprobar" el componente, todavía no hay asignación.
  const idAntes = await generarComisionProduccionSiCorresponde(db, 'req-19b', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.equal(idAntes, null);

  // La asignación llega después — nadie vuelve a llamar la función automáticamente.
  const asistenteId = seedAsignacionPlan(db, { email: 'asistente.tarde@example.com', tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: asistenteId, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-1', usuario_email: 'asistente.tarde@example.com' });

  assert.equal(db._state.comisiones.length, 0, 'la asignación tardía no genera una comisión por sí sola — no es retroactiva');
});

test('el historial de una comisión es append-only: habilitar y programar agregan eventos, nunca reemplazan los anteriores', async () => {
  const db = fakeDb();
  db._state.ventas.push({ id: 'v1', mercado: 'CL' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: isoDaysAgo(11), fecha_pago_total_acreditado: isoDaysAgo(0), fecha_cumplimiento_plazo: null });
  await evaluateComisionGate(db, 'req-hist', 'c1', 'admin@example.com');
  const eventos = db._state.eventos_historial.filter((e) => e.entidad_id === 'c1');
  assert.equal(eventos.length, 2, 'un evento de habilitada y otro de programada, ninguno pisa al otro');
  assert.ok(eventos.some((e) => e.estado_nuevo === 'habilitada'));
  assert.ok(eventos.some((e) => e.estado_nuevo === 'programada'));
});

test('Ficha y Landing de un mismo pack calculan su comisión de producción de forma independiente', async () => {
  const db = fakeDb();
  const asistenteId = seedAsignacionPlan(db, { email: 'asistente@example.com', tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: asistenteId, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-ficha', usuario_email: 'asistente@example.com' });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-landing', usuario_email: 'asistente@example.com' });

  const idFicha = await generarComisionProduccionSiCorresponde(db, 'req-20a', {
    ventaId: 'v1', componente: { id: 'comp-ficha', tipo: 'ficha', precio_atribuido: 45000 }, producto: 'ficha_generico', mercado: 'CL', moneda: 'CLP',
  });
  const idLanding = await generarComisionProduccionSiCorresponde(db, 'req-20b', {
    ventaId: 'v1', componente: { id: 'comp-landing', tipo: 'landing', precio_atribuido: 45000 }, producto: 'ficha_generico', mercado: 'CL', moneda: 'CLP',
  });
  assert.notEqual(idFicha, idLanding);
  assert.equal(db._state.comisiones.filter((c) => c.tipo === 'produccion').length, 2);
});

// --- procesarPagoAcreditadoParaComisiones() ---

test('procesarPagoAcreditadoParaComisiones() — el primer pago acreditado (individual) inicia el plazo de resguardo', async () => {
  const db = fakeDb();
  db._state.pagos_esperados.push({ venta_id: 'v1', tipo: 'total', estado: 'acreditado' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null });
  await procesarPagoAcreditadoParaComisiones(db, 'req-21', { ventaId: 'v1', pagoTipo: 'total', actorEmail: 'admin@example.com' });
  const c = db._state.comisiones.find((x) => x.id === 'c1');
  assert.ok(c.fecha_inicio_plazo);
  assert.ok(c.fecha_pago_total_acreditado, 'en un producto individual, el único pago también es el pago total');
});

test('procesarPagoAcreditadoParaComisiones() — en un pack, el pago inicial NO marca pago total acreditado hasta que el saldo también lo esté', async () => {
  const db = fakeDb();
  db._state.pagos_esperados.push({ venta_id: 'v1', tipo: 'inicial', estado: 'acreditado' });
  db._state.pagos_esperados.push({ venta_id: 'v1', tipo: 'saldo', estado: 'pendiente' });
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional', fecha_inicio_plazo: null, fecha_pago_total_acreditado: null });
  await procesarPagoAcreditadoParaComisiones(db, 'req-22', { ventaId: 'v1', pagoTipo: 'inicial', actorEmail: 'admin@example.com' });
  const c = db._state.comisiones.find((x) => x.id === 'c1');
  assert.ok(c.fecha_inicio_plazo, 'el inicial SÍ es el primer pago del pack');
  assert.equal(c.fecha_pago_total_acreditado, null, 'el saldo todavía está pendiente');
});

// --- marcarComisionPagada() ---

test('marcarComisionPagada() — rechaza pagar una comisión que no está programada', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'calculada_provisional' });
  await assert.rejects(
    () => marcarComisionPagada(db, 'req-23', { comisionId: 'c1', actorEmail: 'admin@example.com' }),
    (e) => { assert.ok(e instanceof ComisionError); assert.equal(e.code, 'transicion_invalida'); return true; }
  );
});

test('marcarComisionPagada() — rechaza pagar una comisión retenida por disputa', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'retenida' });
  await assert.rejects(() => marcarComisionPagada(db, 'req-24', { comisionId: 'c1', actorEmail: 'admin@example.com' }));
});

test('marcarComisionPagada() — marca como pagada una comisión programada', async () => {
  const db = fakeDb();
  db._state.comisiones.push({ id: 'c1', venta_id: 'v1', estado: 'programada' });
  await marcarComisionPagada(db, 'req-25', { comisionId: 'c1', actorEmail: 'admin@example.com' });
  assert.equal(db._state.comisiones.find((c) => c.id === 'c1').estado, 'pagada');
});

// --- Costos directos y prorrateo ---

test('registrarCostoDirecto() — queda registrado con quien lo autorizó, de forma auditable', async () => {
  const db = fakeDb();
  const id = await registrarCostoDirecto(db, 'req-26', { componenteId: 'comp-1', tipo: 'dominio_propio', monto: 15000, moneda: 'CLP', autorizadoPor: 'admin@example.com' });
  assert.ok(id);
  assert.equal(db._state.costos_directos[0].autorizado_por, 'admin@example.com');
  assert.equal(db._state.costos_directos[0].monto, 15000);
});

test('registrarCostoMedioPago() — en un producto individual, todo el costo va a su único componente', async () => {
  const db = fakeDb();
  db._state.proyectos.push({ id: 'p1', venta_id: 'v1' });
  db._state.componentes.push({ id: 'comp-1', proyecto_id: 'p1', precio_atribuido: 50000 });
  const ids = await registrarCostoMedioPago(db, 'req-27', { ventaId: 'v1', tipo: 'medio_pago', monto: 1000, moneda: 'CLP', autorizadoPor: 'admin@example.com' });
  assert.equal(ids.length, 1);
  assert.equal(db._state.costos_directos[0].componente_id, 'comp-1');
  assert.equal(db._state.costos_directos[0].monto, 1000);
});

test('registrarCostoMedioPago() — en un pack, prorratea con el mismo criterio proporcional que el precio del pack', async () => {
  const db = fakeDb();
  db._state.proyectos.push({ id: 'p1', venta_id: 'v1' });
  db._state.componentes.push({ id: 'comp-ficha', proyecto_id: 'p1', tipo: 'ficha', precio_atribuido: 45000 });
  db._state.componentes.push({ id: 'comp-landing', proyecto_id: 'p1', tipo: 'landing', precio_atribuido: 45000 });
  const ids = await registrarCostoMedioPago(db, 'req-28', { ventaId: 'v1', tipo: 'medio_pago', monto: 1000, moneda: 'CLP', autorizadoPor: 'admin@example.com' });
  assert.equal(ids.length, 2);
  const total = db._state.costos_directos.reduce((sum, c) => sum + c.monto, 0);
  assert.equal(total, 1000, 'la suma de las partes siempre da el monto total, igual que el prorrateo del precio del pack');
  assert.equal(db._state.costos_directos[0].monto, 500); // 45000/90000 * 1000, redondeado.
  assert.equal(db._state.costos_directos[1].monto, 500);
});

test('registrarCostoMedioPago() — venta sin proyecto encontrado devuelve un error explícito', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => registrarCostoMedioPago(db, 'req-29', { ventaId: 'no-existe', tipo: 'medio_pago', monto: 1000, moneda: 'CLP', autorizadoPor: 'admin@example.com' }),
    (e) => { assert.ok(e instanceof ComisionError); return true; }
  );
});
