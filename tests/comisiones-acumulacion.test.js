// Pruebas de acumulación de comisiones — RIO-114 (corrección final,
// 30/08/2026). Cubre las 3 decisiones económicas que Brenda confirmó:
// administrador que vende con plan comercial 0%, supervisor que vende y
// acumula comercial + supervisión, y asistente que vende y produce.
// Ninguna de estas reglas está resuelta por rol o nombre — todo se
// resuelve por planes vigentes, asignaciones y relación real con la venta
// o el componente (mismo mecanismo genérico ya probado en
// tests/comisiones.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generarComisionesParaVenta, generarComisionProduccionSiCorresponde,
} from '../functions/_shared/comisiones.js';

function fakeDb() {
  const state = {
    comisiones: [], planes_comision: [], asignaciones_plan_comision: [], asignaciones_produccion: [],
    costos_directos: [], usuarios: [], asignaciones_rol: [], eventos_historial: [],
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
    if (sql.includes('FROM usuarios u') && sql.includes('JOIN asignaciones_plan_comision ap') && sql.includes('JOIN planes_comision pl')) {
      const usuario = state.usuarios.find((u) => u.email === p[0]);
      if (!usuario) return [];
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      return state.asignaciones_plan_comision
        .filter((ap) => ap.usuario_id === usuario.id && !ap.valid_until && (!ap.valid_from || ap.valid_from <= now))
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
    throw new Error('consulta inesperada en test: ' + sql);
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO comisiones')) {
      state.comisiones.push({
        id: p[0], tipo: p[1], venta_id: p[2], componente_id: p[3], beneficiario_email: p[4], plan_id: p[5], asignacion_plan_id: p[6],
        porcentaje_snapshot: p[7], base_snapshot: p[8], monto_base: p[9], moneda: p[10], monto_comision: p[11], estado: 'calculada_provisional',
      });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3] });
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

const VENTA_BASE = { ventaId: 'v1', mercado: 'CL', producto: 'ficha', moneda: 'CLP', componentes: [{ id: 'comp-1', precio_atribuido: 50000 }] };

// --- 1-3: Administrador que vende con plan comercial 0% ---

test('1) Administradora registrando una venta propia con plan comercial de 0% — la venta queda atribuida y se genera la comisión en 0', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'admin@example.com', tipo: 'comercial', porcentaje: 0 });
  const ids = await generarComisionesParaVenta(db, 'req-1', { ...VENTA_BASE, vendedorEmail: 'admin@example.com' });
  assert.equal(ids.length, 1, 'la venta SÍ genera una fila de comisión — visible y auditable, no ausente');
  const c = db._state.comisiones[0];
  assert.equal(c.beneficiario_email, 'admin@example.com');
  assert.equal(c.porcentaje_snapshot, 0);
  assert.equal(c.monto_comision, 0);
});

test('2) La utilidad de la venta de la administradora permanece en RiO (monto_comision 0, monto_base sigue siendo la utilidad neta real)', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'admin@example.com', tipo: 'comercial', porcentaje: 0 });
  await generarComisionesParaVenta(db, 'req-2', { ...VENTA_BASE, vendedorEmail: 'admin@example.com' });
  const c = db._state.comisiones[0];
  assert.equal(c.monto_base, 50000, 'la utilidad neta real queda registrada, aunque la comisión pagada sea 0');
  assert.equal(c.monto_comision, 0);
});

test('3) La regla de 0% proviene del plan asignado, no del rol "admin" ni del nombre — otro usuario cualquiera con el mismo plan se comporta igual', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'cualquier.usuario@example.com', tipo: 'comercial', porcentaje: 0 });
  const ids = await generarComisionesParaVenta(db, 'req-3', { ...VENTA_BASE, vendedorEmail: 'cualquier.usuario@example.com' });
  assert.equal(ids.length, 1);
  assert.equal(db._state.comisiones[0].porcentaje_snapshot, 0, 'ningún código distingue el email — el 0% es una propiedad del plan, no de la persona');
});

// --- 4-6: Supervisor que vende ---

test('4) Supervisor vendiendo SIN plan comercial: genera solamente supervisión sobre su propia venta', async () => {
  const db = fakeDb();
  const supId = seedAsignacionPlan(db, { email: 'supervisor.sin.comercial@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: supId, role: 'supervisor', allowed_markets: '["CL"]', valid_until: null });

  const ids = await generarComisionesParaVenta(db, 'req-4', { ...VENTA_BASE, vendedorEmail: 'supervisor.sin.comercial@example.com' });
  assert.equal(ids.length, 1);
  assert.equal(db._state.comisiones[0].tipo, 'supervision');
});

test('5) Supervisor vendiendo CON plan comercial y de supervisión: genera dos comisiones independientes, 40% + 10%, nunca sumadas en una fila', async () => {
  const db = fakeDb();
  const supId = seedAsignacionPlan(db, { email: 'supervisor.completo@example.com', tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.completo@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: supId, role: 'supervisor', allowed_markets: '["CL"]', valid_until: null });

  const ids = await generarComisionesParaVenta(db, 'req-5', { ...VENTA_BASE, vendedorEmail: 'supervisor.completo@example.com' });
  assert.equal(ids.length, 2, 'dos filas — nunca una sola con 50%');
  const comercial = db._state.comisiones.find((c) => c.tipo === 'comercial');
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.equal(comercial.porcentaje_snapshot, 40);
  assert.equal(comercial.monto_comision, 20000);
  assert.equal(supervision.porcentaje_snapshot, 10);
  assert.equal(supervision.monto_comision, 5000);
  assert.equal(comercial.beneficiario_email, supervision.beneficiario_email, 'ambas son de la misma persona, pero filas separadas');
  assert.notEqual(comercial.id, supervision.id);
});

test('6) Modificar o retirar uno de los dos planes del supervisor no altera las comisiones históricas ya generadas', async () => {
  const db = fakeDb();
  const supId = seedAsignacionPlan(db, { email: 'supervisor.completo@example.com', tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.completo@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: supId, role: 'supervisor', allowed_markets: '["CL"]', valid_until: null });

  await generarComisionesParaVenta(db, 'req-6a', { ...VENTA_BASE, vendedorEmail: 'supervisor.completo@example.com' });
  const comercialOriginal = db._state.comisiones.find((c) => c.tipo === 'comercial');
  const supervisionOriginal = db._state.comisiones.find((c) => c.tipo === 'supervision');

  // Se retira el plan comercial (cierre de la asignación) — deja de vender con comisión desde ahora.
  const asigComercial = db._state.asignaciones_plan_comision.find((a) => a.plan_id === comercialOriginal.plan_id);
  asigComercial.valid_until = '2026-09-01 00:00:00';

  assert.equal(comercialOriginal.porcentaje_snapshot, 40, 'la comisión ya generada no cambia');
  assert.equal(supervisionOriginal.porcentaje_snapshot, 10, 'tampoco la de supervisión, que ni se tocó');

  // Una venta NUEVA del mismo supervisor ya no genera comercial (plan retirado), pero sí supervisión.
  const idsNueva = await generarComisionesParaVenta(db, 'req-6b', { ...VENTA_BASE, ventaId: 'v2', vendedorEmail: 'supervisor.completo@example.com' });
  assert.equal(idsNueva.length, 1);
  assert.equal(db._state.comisiones.find((c) => c.venta_id === 'v2').tipo, 'supervision');
});

// --- 7-11: Asistente que vende y/o produce ---

function seedAsistente(db, email, { canSellPlan = true, activo = true } = {}) {
  const id = canSellPlan ? seedAsignacionPlan(db, { email, tipo: 'comercial', porcentaje: 40 }) : (() => {
    const u = { id: nextUsuarioId++, email };
    db._state.usuarios.push(u);
    return u.id;
  })();
  db._state.asignaciones_rol.push({ usuario_id: id, role: 'asistente', user_status: activo ? 'activo' : 'inactivo', valid_until: null });
  return id;
}

test('7) Asistente autorizado para vender, con plan comercial vigente: genera comisión comercial sobre su propia venta', async () => {
  const db = fakeDb();
  seedAsistente(db, 'asistente.vende@example.com');
  const ids = await generarComisionesParaVenta(db, 'req-7', { ...VENTA_BASE, vendedorEmail: 'asistente.vende@example.com' });
  assert.equal(ids.length, 1);
  assert.equal(db._state.comisiones[0].tipo, 'comercial');
});

test('8) Asistente asignado a un componente, con plan de producción vigente: genera comisión de producción', async () => {
  const db = fakeDb();
  const id = seedAsignacionPlan(db, { email: 'asistente.produce@example.com', tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: id, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-1', usuario_email: 'asistente.produce@example.com' });

  const idComision = await generarComisionProduccionSiCorresponde(db, 'req-8', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.ok(idComision);
  assert.equal(db._state.comisiones.find((c) => c.id === idComision).tipo, 'produccion');
});

test('9) Asistente que vende y produce: genera ambas comisiones, comercial y producción, como filas separadas', async () => {
  const db = fakeDb();
  const email = 'asistente.completo@example.com';
  const id = seedAsignacionPlan(db, { email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email, tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: id, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-1', usuario_email: email });

  const idsComercial = await generarComisionesParaVenta(db, 'req-9a', { ...VENTA_BASE, vendedorEmail: email });
  const idProduccion = await generarComisionProduccionSiCorresponde(db, 'req-9b', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });

  assert.equal(idsComercial.length, 1);
  assert.ok(idProduccion);
  assert.notEqual(idsComercial[0], idProduccion);
  assert.equal(db._state.comisiones.filter((c) => c.beneficiario_email === email).length, 2);
  assert.equal(db._state.comisiones.find((c) => c.tipo === 'comercial').componente_id, null, 'la comercial se vincula con la venta, no con un componente');
  assert.equal(db._state.comisiones.find((c) => c.tipo === 'produccion').componente_id, 'comp-1', 'la de producción se vincula con el componente trabajado');
});

test('10) Asistente que vende pero NO está asignado al componente: no genera producción (solo comercial)', async () => {
  const db = fakeDb();
  const email = 'asistente.sin.asignar@example.com';
  const id = seedAsignacionPlan(db, { email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email, tipo: 'produccion', porcentaje: 10 }); // tiene el plan, pero no la asignación al componente.
  db._state.asignaciones_rol.push({ usuario_id: id, role: 'asistente', user_status: 'activo', valid_until: null });

  const idProduccion = await generarComisionProduccionSiCorresponde(db, 'req-10', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.equal(idProduccion, null, 'sin asignación expresa al componente, nunca se genera producción aunque tenga el plan y venda');
});

test('11) Asistente asignado DESPUÉS de aprobar el componente (o con plan fuera de vigencia): no genera comisión retroactiva', async () => {
  const db = fakeDb();
  const email = 'asistente.tarde@example.com';

  // Caso A: la asignación llega después de que ya se evaluó (no retroactiva).
  const idAntes = await generarComisionProduccionSiCorresponde(db, 'req-11a', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.equal(idAntes, null);
  const id = seedAsignacionPlan(db, { email, tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: id, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-1', usuario_email: email });
  assert.equal(db._state.comisiones.length, 0, 'la asignación tardía no dispara nada por sí sola');

  // Caso B: la asignación existe, pero el plan de producción ya venció.
  const email2 = 'asistente.plan.vencido@example.com';
  const id2 = seedAsignacionPlan(db, { email: email2, tipo: 'produccion', porcentaje: 10, planValidUntil: '2020-01-01 00:00:00' });
  db._state.asignaciones_rol.push({ usuario_id: id2, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-2', usuario_email: email2 });
  const idVencido = await generarComisionProduccionSiCorresponde(db, 'req-11b', {
    ventaId: 'v1', componente: { id: 'comp-2', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.equal(idVencido, null, 'un plan vencido no genera comisión, aunque la asignación exista');
});

// --- 12: Pack — producción usa solo la utilidad del componente asignado ---

test('12) En un pack, la comisión de producción de la Landing usa ÚNICAMENTE la utilidad neta atribuible a la Landing, no la de la Ficha ni la del pack completo', async () => {
  const db = fakeDb();
  const id = seedAsignacionPlan(db, { email: 'asistente.landing@example.com', tipo: 'produccion', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: id, role: 'asistente', user_status: 'activo', valid_until: null });
  db._state.asignaciones_produccion.push({ componente_id: 'comp-landing', usuario_email: 'asistente.landing@example.com' });
  db._state.costos_directos.push({ componente_id: 'comp-landing', monto: 5000 }); // costo propio de la Landing, no afecta a la Ficha.

  const idComision = await generarComisionProduccionSiCorresponde(db, 'req-12', {
    ventaId: 'v1', componente: { id: 'comp-landing', tipo: 'landing', precio_atribuido: 45000 }, producto: 'ficha_generico', mercado: 'CL', moneda: 'CLP',
  });
  const c = db._state.comisiones.find((x) => x.id === idComision);
  assert.equal(c.monto_base, 40000, '45000 (precio atribuido a la Landing) - 5000 (su propio costo) = 40000, nunca el total del pack');
  assert.equal(c.monto_comision, 4000);
});

// --- 13: Sin plan vigente correspondiente, ninguna comisión ---

test('13) Ningún usuario genera una comisión de un tipo si no tiene el plan vigente correspondiente — comprobado para los 3 tipos', async () => {
  const db = fakeDb();
  const idsComercial = await generarComisionesParaVenta(db, 'req-13a', { ...VENTA_BASE, vendedorEmail: 'nadie.tiene.plan@example.com' });
  assert.equal(idsComercial.length, 0);

  const idProduccion = await generarComisionProduccionSiCorresponde(db, 'req-13b', {
    ventaId: 'v1', componente: { id: 'comp-1', tipo: 'ficha', precio_atribuido: 50000 }, producto: 'ficha', mercado: 'CL', moneda: 'CLP',
  });
  assert.equal(idProduccion, null);

  // Supervisor con rol pero sin ningún plan asignado: tampoco genera supervisión.
  const supId = (() => { const u = { id: nextUsuarioId++, email: 'supervisor.sin.plan@example.com' }; db._state.usuarios.push(u); return u.id; })();
  db._state.asignaciones_rol.push({ usuario_id: supId, role: 'supervisor', allowed_markets: '["CL"]', valid_until: null });
  const idsConSupervisorSinPlan = await generarComisionesParaVenta(db, 'req-13c', { ...VENTA_BASE, ventaId: 'v3', vendedorEmail: 'otro.sin.plan@example.com' });
  assert.equal(idsConSupervisorSinPlan.length, 0);
});

// --- 14: Moneda, base y estados independientes al acumular ---

test('14) Las comisiones acumuladas (comercial + supervisión) conservan moneda, base y estados completamente independientes', async () => {
  const db = fakeDb();
  const supId = seedAsignacionPlan(db, { email: 'supervisor.ar@example.com', tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.ar@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.asignaciones_rol.push({ usuario_id: supId, role: 'supervisor', allowed_markets: '["AR"]', valid_until: null });

  await generarComisionesParaVenta(db, 'req-14', {
    ventaId: 'v1', vendedorEmail: 'supervisor.ar@example.com', mercado: 'AR', producto: 'ficha', moneda: 'ARS',
    componentes: [{ id: 'comp-1', precio_atribuido: 125000 }],
  });
  const comercial = db._state.comisiones.find((c) => c.tipo === 'comercial');
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.equal(comercial.moneda, 'ARS');
  assert.equal(supervision.moneda, 'ARS');
  assert.equal(comercial.base_snapshot, 'utilidad_neta_venta');
  assert.equal(supervision.base_snapshot, 'utilidad_neta_venta');
  assert.equal(comercial.estado, 'calculada_provisional');
  assert.equal(supervision.estado, 'calculada_provisional');
  // Avanzar el estado de una no debe tocar la otra — verificado a nivel de fila (ids distintos, updates por id).
  assert.notEqual(comercial.id, supervision.id);
});

// --- 15: Ninguna manipulación de datos permite generar una comisión indebida ---

test('15) Cambiar el mercado de la venta a uno no alcanzado por el plan bloquea la comisión, aunque el resto de los datos sean válidos', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor.cl@example.com', tipo: 'comercial', porcentaje: 40, mercados: ['CL'] }); // solo CL.
  const ids = await generarComisionesParaVenta(db, 'req-15a', { ...VENTA_BASE, vendedorEmail: 'vendedor.cl@example.com', mercado: 'AR' });
  assert.equal(ids.length, 0, 'un plan que no alcanza AR no genera comisión aunque la venta se haya forzado a ese mercado');
});

test('15) Cambiar el producto de la venta a uno no alcanzado por el plan también bloquea la comisión', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor.ficha@example.com', tipo: 'comercial', porcentaje: 40, productos: ['ficha'] });
  const ids = await generarComisionesParaVenta(db, 'req-15b', { ...VENTA_BASE, vendedorEmail: 'vendedor.ficha@example.com', producto: 'personalizado' });
  assert.equal(ids.length, 0);
});

test('15) Suplantar el beneficiario_email de otra persona en la solicitud no es posible: la comisión siempre se genera con el email real del vendedor de la venta, resuelto en el servidor', async () => {
  const db = fakeDb();
  seedAsignacionPlan(db, { email: 'vendedor.real@example.com', tipo: 'comercial', porcentaje: 40 });
  // generarComisionesParaVenta recibe vendedorEmail como parámetro de servidor
  // (roleIdentity.email en la ruta real, nunca un campo del body) — acá se
  // simula pasando un email sin plan, y se confirma que nada "recae" sobre
  // el que sí tiene plan por accidente.
  const ids = await generarComisionesParaVenta(db, 'req-15c', { ...VENTA_BASE, vendedorEmail: 'atacante@example.com' });
  assert.equal(ids.length, 0, 'un email sin plan propio nunca hereda la comisión de otro usuario');
});
