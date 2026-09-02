// Pruebas de functions/interno/api/ventas/* — RIO-112.
// Cubre en particular los requisitos de aislamiento: un ejecutivo no puede
// ver ventas de otro (ni cambiando el id en la ruta), y el alcance por
// mercado se respeta para admin/supervisor. Invoca los handlers con un
// `context` fabricado, igual que tests/identidad.test.js — la resolución
// de rol/mercado (RIO-111) ya se prueba aparte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as ventasHandler } from '../functions/interno/api/ventas/index.js';
import { onRequest as ventaDetailHandler } from '../functions/interno/api/ventas/[id].js';
import { PERMISSIONS } from '../functions/_shared/authz.js';
import { MARKETS } from '../interno/config/markets.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'ejecutivo.a@example.com',
    nombre: 'Ejecutivo A',
    role: 'ejecutivo',
    allowedMarkets: ['CL'],
    defaultMarket: 'CL',
    userStatus: 'activo',
    canSell: true,
    permissions: PERMISSIONS.ejecutivo,
    ...overrides,
  };
}

// D1 simulado en memoria: soporta las sentencias reales que usan
// ventas/index.js y ventas/[id].js — INSERT vía batch() y los SELECT con
// join a clientes. No es un motor SQL real, pero respeta el mismo
// contrato prepare().bind().all()/.first() y batch() que usa el código.
const PRODUCTOS = ['ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado'];

function fakeDb(seed = { clientes: [], ventas: [], proyectos: [], componentes: [], pagos_esperados: [] }) {
  seed.pagos_esperados = seed.pagos_esperados || [];
  // RIO-114 (corrección): ventas/index.js genera comisiones al crear una
  // venta resolviendo una ASIGNACIÓN de plan vigente (usuario + plan
  // versionado), no una tabla plana por producto. Por defecto no se siembra
  // ningún usuario/plan/asignación — sin ellos, resolverAsignacionVigente()
  // no encuentra nada y no se genera ninguna comisión (0 filas), que es el
  // comportamiento correcto para la mayoría de estas pruebas (no les
  // importa comisiones). Las pruebas que sí las ejercitan siembran
  // explícitamente lo que necesitan vía db._state.
  seed.planes_comision = seed.planes_comision || [];
  seed.asignaciones_plan_comision = seed.asignaciones_plan_comision || [];
  seed.costos_directos = seed.costos_directos || [];
  seed.comisiones = seed.comisiones || [];
  seed.eventos_historial = seed.eventos_historial || [];
  seed.usuarios = seed.usuarios || [];
  seed.asignaciones_rol = seed.asignaciones_rol || [];
  seed.asignaciones_realizacion = seed.asignaciones_realizacion || [];
  seed.equipo_miembros = seed.equipo_miembros || [];
  seed.equipo_supervisores = seed.equipo_supervisores || [];
  seed.equipos = seed.equipos || [];
  seed.materiales_informados_detalle = seed.materiales_informados_detalle || [];
  seed.materiales_confirmaciones = seed.materiales_confirmaciones || [];
  const state = seed;

  function makeStatement(sql) {
    let boundParams = [];
    return {
      bind(...p) {
        boundParams = p;
        return this;
      },
      _sql: sql,
      _params: () => boundParams,
      all: async () => ({ results: runSelect(sql, boundParams) }),
      first: async () => runSelect(sql, boundParams)[0] || null,
      run: async () => {
        runInsert(sql, boundParams);
        return { success: true };
      },
    };
  }

  function runInsert(sql, p) {
    if (sql.startsWith('INSERT INTO clientes')) {
      state.clientes.push({ id: p[0], negocio: p[1], contacto_nombre: p[2], telefono: p[3], email: p[4], mercado: p[5], datos_facturacion_ar: p[6], created_by: p[7] });
    } else if (sql.startsWith('INSERT INTO ventas')) {
      state.ventas.push({
        id: p[0], codigo_venta: p[1], cliente_id: p[2], mercado: p[3], producto: p[4], moneda: p[5],
        tipo_precio: p[6], precio_pactado: p[7], vendedor_email: p[8], equipo_id: p[9] || null,
        idempotency_key: p[10] || null, origen: p[11] || null, es_demo: p[12] || 0, antecedentes_kit_json: p[13] || null,
        // RIO-118 (corrección — ventas administrativas y comisión de
        // supervisión, 01/09/2026): snapshot inmutable de tipo de venta y
        // supervisión, ver migración 0023.
        tipo_venta: p[14] || 'equipo', supervisor_snapshot_email: p[15] || null, plan_supervision_snapshot_id: p[16] || null,
        supervision_aplica: p[17] === undefined ? 1 : p[17], motivo_sin_supervision: p[18] || null,
        porcentaje_supervision_aplicado: p[19] === undefined ? 10 : p[19], porcentaje_final_empresa: p[20] === undefined ? 20 : p[20],
        estado_actual: 'registrada', created_at: '2026-08-28 00:00:00',
      });
    } else if (sql.startsWith('INSERT INTO proyectos')) {
      state.proyectos.push({ id: p[0], venta_id: p[1], codigo_proyecto: p[2], estado_actual: 'registrado' });
    } else if (sql.startsWith('INSERT INTO componentes')) {
      state.componentes.push({ id: p[0], proyecto_id: p[1], tipo: p[2], precio_individual_referencia: p[3], precio_atribuido: p[4], estado_actual: p[5], materiales_estado: 'pendiente' });
    } else if (sql.startsWith('INSERT INTO pagos_esperados')) {
      state.pagos_esperados.push({ id: p[0], venta_id: p[1], tipo: p[2], monto: p[3], moneda: p[4], estado: 'pendiente' });
    } else if (sql.startsWith('INSERT INTO comisiones')) {
      state.comisiones.push({
        id: p[0], tipo: p[1], rol_realizacion: p[2], venta_id: p[3], componente_id: p[4], beneficiario_email: p[5], plan_id: p[6], asignacion_plan_id: p[7],
        porcentaje_snapshot: p[8], base_snapshot: p[9], monto_base: p[10], moneda: p[11], monto_comision: p[12], estado: 'calculada_provisional',
      });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3] });
    } else {
      throw new Error('INSERT inesperado en test: ' + sql);
    }
  }

  // RIO-119 (panel administrativo, 02/09/2026): equipo_nombre/
  // supervisor_nombre ahora se resuelven también en el LISTADO (antes solo
  // en el detalle) — mismo LEFT JOIN a equipos/usuarios que la consulta
  // real, para que el panel administrativo pueda filtrar sin una consulta
  // extra por fila.
  function enrichVenta(v) {
    return {
      ...v,
      negocio: state.clientes.find((c) => c.id === v.cliente_id)?.negocio,
      vendedor_nombre: state.usuarios.find((u) => u.email === v.vendedor_email)?.nombre,
      proyecto_estado: state.proyectos.find((pr) => pr.venta_id === v.id)?.estado_actual,
      equipo_nombre: state.equipos.find((e) => e.id === v.equipo_id)?.nombre || null,
      supervisor_nombre: state.usuarios.find((u) => u.email === v.supervisor_snapshot_email)?.nombre || null,
    };
  }

  function runSelect(sql, p) {
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.vendedor_email')) {
      return state.ventas.filter((v) => v.vendedor_email === p[0]).map(enrichVenta);
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('equipo_supervisores')) {
      // Rama del supervisor (RIO-118, corrección): propias + equipos que
      // supervisa VIGENTE — nunca "todo el mercado" sin condición. p =
      // [...allowedMarkets, email (propias), email (subquery de equipos)].
      const email = p[p.length - 1];
      const mercados = p.slice(0, p.length - 2);
      const equiposSupervisados = state.equipo_supervisores
        .filter((s) => s.usuario_email === email && !s.valid_until)
        .map((s) => s.equipo_id);
      return state.ventas
        .filter((v) => mercados.includes(v.mercado) && (v.vendedor_email === email || (v.equipo_id && equiposSupervisados.includes(v.equipo_id))))
        .map(enrichVenta);
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.mercado IN')) {
      return state.ventas.filter((v) => p.includes(v.mercado)).map(enrichVenta);
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.id = ?')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      if (!v) return [];
      const c = state.clientes.find((x) => x.id === v.cliente_id);
      return [{
        ...v, negocio: c?.negocio, contacto_nombre: c?.contacto_nombre, telefono: c?.telefono, cliente_email: c?.email, datos_facturacion_ar: c?.datos_facturacion_ar,
        vendedor_nombre: state.usuarios.find((u) => u.email === v.vendedor_email)?.nombre,
        // RIO-118 (corrección — ventas administrativas y comisión de
        // supervisión): equipo/supervisor resueltos por LEFT JOIN — pueden
        // ser null (equipo no asignado / venta directa), igual que en D1 real.
        equipo_nombre: state.equipos.find((e) => e.id === v.equipo_id)?.nombre || null,
        supervisor_nombre: state.usuarios.find((u) => u.email === v.supervisor_snapshot_email)?.nombre || null,
      }];
    }
    if (sql.startsWith('SELECT 1 FROM equipo_supervisores')) {
      const match = state.equipo_supervisores.find((s) => s.equipo_id === p[0] && s.usuario_email === p[1] && !s.valid_until);
      return match ? [{ 1: 1 }] : [];
    }
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) {
      return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    }
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) {
      return state.componentes.filter((c) => c.proyecto_id === p[0]);
    }
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) {
      return state.pagos_esperados.filter((pg) => pg.venta_id === p[0]);
    }
    if (sql.startsWith('SELECT monto FROM costos_directos WHERE componente_id')) {
      return state.costos_directos.filter((c) => c.componente_id === p[0]);
    }
    if (sql.startsWith("SELECT monto, nota FROM costos_directos WHERE componente_id")) {
      return state.costos_directos.filter((c) => c.componente_id === p[0] && c.tipo === 'dominio');
    }
    if (sql.startsWith("SELECT id FROM costos_directos WHERE componente_id")) {
      return state.costos_directos.filter((c) => c.componente_id === p[0] && c.tipo === 'dominio');
    }
    if (sql.startsWith('SELECT producto FROM ventas WHERE id')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      return v ? [{ producto: v.producto }] : [];
    }
    if (sql.startsWith('SELECT id, tipo FROM componentes WHERE id')) {
      const c = state.componentes.find((x) => x.id === p[0]);
      return c ? [{ id: c.id, tipo: c.tipo }] : [];
    }
    if (sql.startsWith("SELECT id FROM componentes WHERE proyecto_id") && sql.includes("tipo = 'landing'")) {
      return state.componentes.filter((c) => c.proyecto_id === p[0] && c.tipo === 'landing');
    }
    if (sql.includes('FROM materiales_informados_detalle m') && sql.includes('WHERE m.componente_id')) {
      return state.materiales_informados_detalle
        .filter((m) => m.componente_id === p[0])
        .map((m) => ({
          ...m,
          informado_por_nombre: (state.usuarios || []).find((u) => u.email === m.informado_por)?.nombre || null,
          revisado_por_nombre: (state.usuarios || []).find((u) => u.email === m.revisado_por)?.nombre || null,
        }));
    }
    if (sql.startsWith('SELECT * FROM materiales_confirmaciones WHERE componente_id')) {
      return state.materiales_confirmaciones.filter((m) => m.componente_id === p[0]);
    }
    if (sql.includes('FROM usuarios u') && sql.includes('JOIN asignaciones_plan_comision ap') && sql.includes('JOIN planes_comision pl')) {
      // resolverAsignacionVigente(): bind = [usuarioEmail, tipo].
      const usuario = state.usuarios.find((u) => u.email === p[0]);
      if (!usuario) return [];
      return state.asignaciones_plan_comision
        .filter((ap) => ap.usuario_id === usuario.id && !ap.valid_until)
        .map((ap) => ({ asignacion: ap, plan: state.planes_comision.find((pl) => pl.id === ap.plan_id) }))
        .filter((x) => x.plan && x.plan.tipo === p[1] && x.plan.estado === 'activo' && !x.plan.valid_until)
        .sort((a, b) => (a.asignacion.valid_from < b.asignacion.valid_from ? 1 : -1))
        .map((x) => ({
          asignacion_id: x.asignacion.id, plan_id: x.plan.id, porcentaje: x.plan.porcentaje, base: x.plan.base,
          productos_alcanzados: x.plan.productos_alcanzados, mercados_alcanzados: x.plan.mercados_alcanzados,
        }));
    }
    if (sql.startsWith('SELECT id, mercado FROM equipos WHERE id')) {
      const eq = state.equipos.find((e) => e.id === p[0]);
      return eq ? [{ id: eq.id, mercado: eq.mercado }] : [];
    }
    if (sql.startsWith('SELECT equipo_id FROM equipo_miembros')) {
      return state.equipo_miembros.filter((m) => m.usuario_email === p[0] && !m.valid_until);
    }
    if (sql.startsWith('SELECT usuario_email FROM equipo_supervisores')) {
      return state.equipo_supervisores.filter((s) => s.equipo_id === p[0] && !s.valid_until);
    }
    if (sql.startsWith('SELECT usuario_email, rol FROM asignaciones_realizacion WHERE componente_id')) {
      return state.asignaciones_realizacion.filter((a) => a.componente_id === p[0]);
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }

  return {
    _state: state,
    prepare: (sql) => makeStatement(sql),
    batch: async (statements) => {
      for (const stmt of statements) {
        await stmt.run();
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

function fakeContext({ method = 'GET', url = 'https://rioimpulsodigital.com/interno/api/ventas', body, roleIdentity: ri, db, params = {} } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request(url, init),
    env: { DB: db },
    params,
    data: { requestId: 'req-ventas-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

// RIO-114 (corrección): siembra un usuario + plan + asignación vigente
// para que resolverAsignacionVigente() encuentre algo real, en vez de
// depender de una tabla plana. Refleja el modelo de dos pasos (definición
// de plan + asignación versionada) que reemplazó la tabla por producto.
let nextUsuarioId = 1;
function seedAsignacionPlan(db, { email, tipo, porcentaje, productos = PRODUCTOS, mercados = ['CL', 'AR'] }) {
  // Una misma persona puede tener más de un plan vigente a la vez (ej. un
  // supervisor que también vende: comercial + supervisión) — deben
  // resolver al MISMO registro de usuarios, igual que en D1 real (email
  // único), o la búsqueda por email en el mock solo encontraría el primero.
  const existente = db._state.usuarios.find((u) => u.email === email);
  const usuarioId = existente ? existente.id : nextUsuarioId++;
  if (!existente) db._state.usuarios.push({ id: usuarioId, email });
  const planId = `plan-${tipo}-${porcentaje}-${usuarioId}`;
  db._state.planes_comision.push({
    id: planId, tipo, porcentaje, base: tipo === 'produccion' ? 'utilidad_neta_componente' : 'utilidad_neta_venta',
    productos_alcanzados: JSON.stringify(productos), mercados_alcanzados: JSON.stringify(mercados), estado: 'activo', valid_until: null,
  });
  db._state.asignaciones_plan_comision.push({ id: `asig-${planId}`, usuario_id: usuarioId, plan_id: planId, valid_until: null });
  return usuarioId;
}

const CL_INDIVIDUAL = { mercado: 'CL', cliente: { negocio: 'Ferretería El Tornillo' }, producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 50000 };
const CL_PACK = {
  mercado: 'CL', cliente: { negocio: 'Barbería Central' }, producto: 'ficha_generico', tipoPrecio: 'lanzamiento',
  precioPactado: 90000, precioFichaIndividual: 50000, precioLandingIndividual: 50000,
};

test('POST /ventas — crea una venta individual con un solo componente', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.venta.mercado, 'CL');
  assert.equal(body.data.componentes.length, 1);
  assert.equal(body.data.componentes[0].precioAtribuido, 50000);
  assert.equal(body.data.componentes[0].estadoActual, 'pendiente');
});

test('POST /ventas — con plan comercial vigente (40% confirmado), genera la comisión sobre la utilidad neta de la venta', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  seedAsignacionPlan(db, { email: ri.email, tipo: 'comercial', porcentaje: 40 });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comisiones.length, 1, 'sin supervisor sembrado, solo debe generarse la comercial');
  const comision = db._state.comisiones[0];
  assert.equal(comision.tipo, 'comercial');
  assert.equal(comision.beneficiario_email, ri.email);
  assert.equal(comision.porcentaje_snapshot, 40);
  assert.equal(comision.monto_base, 50000); // sin costos directos, utilidad neta = precio pactado.
  assert.equal(comision.monto_comision, 20000); // 40% de 50000.
  assert.equal(comision.estado, 'calculada_provisional');
});

test('POST /ventas — un vendedor SIN plan comercial activo no genera ninguna comisión comercial (nunca un número inventado)', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201, 'la venta se registra igual — la atribución no depende de tener plan');
  assert.equal(db._state.comisiones.length, 0, 'sin plan comercial vigente, no se genera fila alguna — ni siquiera con porcentaje nulo');
});

test('POST /ventas — un plan cuyos productos_alcanzados no incluyen este producto tampoco genera comisión', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  seedAsignacionPlan(db, { email: ri.email, tipo: 'comercial', porcentaje: 40, productos: ['generico'] }); // no incluye 'ficha'.
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comisiones.length, 0);
});

// RIO-115 (consolidación 31/08/2026): "mercado no equivale a equipo" — la
// comisión de supervisión ahora depende de un equipo explícito
// (equipo_miembros / equipo_supervisores), snapshotteado en ventas.equipo_id
// al momento de la venta, nunca de "todos los supervisores del mercado".
function seedEquipo(db, { equipoId = `equipo-${Math.random().toString(36).slice(2)}`, mercado, miembroEmail, supervisorEmail }) {
  db._state.equipo_miembros.push({ equipo_id: equipoId, usuario_email: miembroEmail, valid_until: null });
  if (supervisorEmail) {
    db._state.equipo_supervisores.push({ equipo_id: equipoId, usuario_email: supervisorEmail, valid_until: null });
  }
  return equipoId;
}

test('POST /ventas — genera además una comisión de supervisión (10% confirmado) para el supervisor VIGENTE del equipo del vendedor, con su propio plan', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  seedAsignacionPlan(db, { email: ri.email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.cl@example.com', tipo: 'supervision', porcentaje: 10 });
  seedEquipo(db, { mercado: 'CL', miembroEmail: ri.email, supervisorEmail: 'supervisor.cl@example.com' });

  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comisiones.length, 2);
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.ok(supervision);
  assert.equal(supervision.beneficiario_email, 'supervisor.cl@example.com');
  assert.equal(supervision.porcentaje_snapshot, 10);
  assert.equal(supervision.monto_comision, 5000); // 10% de 50000.
  assert.equal(supervision.moneda, 'CLP', 'la comisión conserva la moneda original de la venta (CL -> CLP)');
});

test('POST /ventas — un vendedor SIN equipo asignado no genera comisión de supervisión (nunca "todos los supervisores del mercado")', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  seedAsignacionPlan(db, { email: ri.email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.cl@example.com', tipo: 'supervision', porcentaje: 10 });
  // Hay un supervisor con plan vigente en el mercado, pero NINGÚN equipo lo
  // vincula al vendedor — no debe generarse comisión de supervisión.

  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comisiones.length, 1, 'solo la comercial — sin equipo, no hay a quién pagarle supervisión');
  assert.equal(db._state.comisiones[0].tipo, 'comercial');
});

test('POST /ventas — dos supervisores del mismo mercado con equipos distintos: la supervisión va SOLO al supervisor del equipo del vendedor', async () => {
  const db = fakeDb();
  const vendedorEquipoA = roleIdentity({ email: 'ejecutivo.equipoA@example.com' });
  seedAsignacionPlan(db, { email: vendedorEquipoA.email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.a@example.com', tipo: 'supervision', porcentaje: 10 });
  seedAsignacionPlan(db, { email: 'supervisor.b@example.com', tipo: 'supervision', porcentaje: 10 });
  seedEquipo(db, { equipoId: 'equipo-a', mercado: 'CL', miembroEmail: vendedorEquipoA.email, supervisorEmail: 'supervisor.a@example.com' });
  seedEquipo(db, { equipoId: 'equipo-b', mercado: 'CL', miembroEmail: 'otro.vendedor@example.com', supervisorEmail: 'supervisor.b@example.com' });

  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: vendedorEquipoA, db }));
  assert.equal(response.status, 201);
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.ok(supervision);
  assert.equal(supervision.beneficiario_email, 'supervisor.a@example.com', 'nunca el supervisor de otro equipo del mismo mercado');
});

test('POST /ventas en AR — la comisión de supervisión se genera en ARS, nunca convertida', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ allowedMarkets: ['AR'] });
  seedAsignacionPlan(db, { email: ri.email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.ar@example.com', tipo: 'supervision', porcentaje: 10 });
  seedEquipo(db, { mercado: 'AR', miembroEmail: ri.email, supervisorEmail: 'supervisor.ar@example.com' });

  const AR_INDIVIDUAL = { mercado: 'AR', cliente: { negocio: 'Estudio Uñas' }, producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 125000 };
  const response = await ventasHandler(fakeContext({ method: 'POST', body: AR_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.equal(supervision.moneda, 'ARS');
});

test('POST /ventas — crea un pack con dos componentes, precio distribuido y Landing bloqueada desde el inicio', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_PACK, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.componentes.length, 2);
  const ficha = body.data.componentes.find((c) => c.tipo === 'ficha');
  const landing = body.data.componentes.find((c) => c.tipo === 'landing');
  assert.equal(ficha.precioAtribuido + landing.precioAtribuido, 90000);
  assert.equal(ficha.estadoActual, 'pendiente');
  assert.equal(landing.estadoActual, 'bloqueada', 'la Landing nunca debe arrancar habilitada — flujo secuencial de Brenda');
});

test('POST /ventas — rechaza un precio que no corresponde a un precio vigente', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: { ...CL_INDIVIDUAL, precioPactado: 1 }, roleIdentity: ri, db }));
  assert.equal(response.status, 400);
});

test('POST /ventas — rechaza un mercado fuera de allowedMarkets del ejecutivo', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ allowedMarkets: ['CL'] });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: { ...CL_PACK, mercado: 'AR' }, roleIdentity: ri, db }));
  assert.equal(response.status, 403);
});

test('POST /ventas — un asistente sin can_sell no puede registrar ventas', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ role: 'asistente', permissions: PERMISSIONS.asistente, canSell: false });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 403);
});

test('POST /ventas — un asistente CON can_sell sí puede registrar una venta propia (capacidad, no rol)', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ role: 'asistente', permissions: PERMISSIONS.asistente, canSell: true, email: 'practicante@example.com' });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
});

test('POST /ventas — un ejecutivo SIN can_sell no puede registrar ventas (la capacidad no depende del rol)', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ canSell: false });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 403);
});

test('GET /ventas — un ejecutivo solo ve sus propias ventas, nunca las de otro (aislamiento)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const b = roleIdentity({ email: 'ejecutivo.b@example.com' });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  await ventasHandler(fakeContext({ method: 'POST', body: { ...CL_INDIVIDUAL, cliente: { negocio: 'Otro negocio' } }, roleIdentity: b, db }));

  const responseA = await ventasHandler(fakeContext({ roleIdentity: a, db }));
  const bodyA = await responseA.json();
  assert.equal(bodyA.data.ventas.length, 1);
  assert.equal(bodyA.data.ventas[0].vendedorEmail, 'ejecutivo.a@example.com');

  const responseB = await ventasHandler(fakeContext({ roleIdentity: b, db }));
  const bodyB = await responseB.json();
  assert.equal(bodyB.data.ventas.length, 1);
  assert.equal(bodyB.data.ventas[0].vendedorEmail, 'ejecutivo.b@example.com');
});

test('GET /ventas — expone el avance real del proyecto (RIO-117: ventas.estadoActual nunca transiciona, el que importa es el del proyecto)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  assert.equal(db._state.proyectos[0].estado_actual, 'registrado');

  const response = await ventasHandler(fakeContext({ roleIdentity: a, db }));
  const body = await response.json();
  assert.equal(body.data.ventas[0].proyectoEstado, 'registrado');

  db._state.proyectos[0].estado_actual = 'completado';
  const response2 = await ventasHandler(fakeContext({ roleIdentity: a, db }));
  const body2 = await response2.json();
  assert.equal(body2.data.ventas[0].proyectoEstado, 'completado', 'el listado refleja el avance real, no el placeholder fijo de ventas.estado_actual');
});

test('GET /ventas — un admin ve todas las ventas de SUS mercados autorizados, no de otros (sin restricción de equipo — no tiene equipos propios)', async () => {
  const db = fakeDb();
  const ejecutivoCl = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const ejecutivoAr = roleIdentity({ email: 'ejecutivo.ar@example.com', allowedMarkets: ['AR'] });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ejecutivoCl, db }));
  await ventasHandler(fakeContext({
    method: 'POST',
    body: { mercado: 'AR', cliente: { negocio: 'Estudio Uñas' }, producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 125000 },
    roleIdentity: ejecutivoAr, db,
  }));

  const adminAmbos = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const responseAmbos = await ventasHandler(fakeContext({ roleIdentity: adminAmbos, db }));
  const bodyAmbos = await responseAmbos.json();
  assert.equal(bodyAmbos.data.ventas.length, 2);
});

// RIO-118 (corrección — modelo de equipos, 01/09/2026): "no asumir que
// mercado equivale a equipo" aplica también al listado de ventas de un
// supervisor, no solo a comisiones (RIO-115). Antes de esta corrección un
// supervisor veía TODAS las ventas de su mercado, incluidas las de
// equipos que no supervisa — acá se prueba explícitamente que eso ya no
// pasa, y que sigue viendo lo que sí le corresponde: lo propio y lo de
// sus equipos vigentes (potencialmente varios, en varios mercados).
test('GET /ventas — un supervisor ve sus ventas propias y las de los equipos que supervisa VIGENTE, nunca las de un equipo ajeno del mismo mercado', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'ejecutivo.cl@example.com', valid_until: null });
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-2', usuario_email: 'ejecutivo.cl.otro@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'supervisor@example.com', valid_until: null });
  // equipo-cl-2 tiene OTRO supervisor — supervisor@example.com no lo supervisa.
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-2', usuario_email: 'otro.supervisor@example.com', valid_until: null });

  const ejecutivoCl = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const ejecutivoClOtroEquipo = roleIdentity({ email: 'ejecutivo.cl.otro@example.com', allowedMarkets: ['CL'] });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ejecutivoCl, db }));
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ejecutivoClOtroEquipo, db }));

  const supervisorCl = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  const response = await ventasHandler(fakeContext({ roleIdentity: supervisorCl, db }));
  const body = await response.json();
  assert.equal(body.data.ventas.length, 1, 'solo ve la venta del equipo que supervisa, no la del equipo ajeno del mismo mercado');
  assert.equal(body.data.ventas[0].vendedorEmail, 'ejecutivo.cl@example.com');
});

test('GET /ventas — un supervisor con equipos en AR y CL ve las ventas de AMBOS equipos', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'ejecutivo.cl@example.com', valid_until: null });
  db._state.equipo_miembros.push({ equipo_id: 'equipo-ar-1', usuario_email: 'ejecutivo.ar@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-ar-1', usuario_email: 'alberto@example.com', valid_until: null });

  const ejecutivoCl = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const ejecutivoAr = roleIdentity({ email: 'ejecutivo.ar@example.com', allowedMarkets: ['AR'] });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ejecutivoCl, db }));
  await ventasHandler(fakeContext({
    method: 'POST',
    body: { mercado: 'AR', cliente: { negocio: 'Estudio Uñas' }, producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 125000 },
    roleIdentity: ejecutivoAr, db,
  }));

  const alberto = roleIdentity({ email: 'alberto@example.com', role: 'supervisor', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.supervisor });
  const response = await ventasHandler(fakeContext({ roleIdentity: alberto, db }));
  const body = await response.json();
  assert.equal(body.data.ventas.length, 2, 've las ventas de sus dos equipos, uno por mercado — nunca "todo AR y todo CL" sin condición');
});

test('GET /ventas — un supervisor SIN ningún equipo vigente en un mercado no ve ventas ajenas de ese mercado, aunque esté en su allowedMarkets', async () => {
  const db = fakeDb();
  const ejecutivoCl = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ejecutivoCl, db })); // sin equipo asignado.

  const supervisorSinEquipo = roleIdentity({ email: 'supervisor.nuevo@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  const response = await ventasHandler(fakeContext({ roleIdentity: supervisorSinEquipo, db }));
  const body = await response.json();
  assert.equal(body.data.ventas.length, 0);
});

test('GET /ventas — un asistente puede listar (solo ve las suyas, igual que un ejecutivo — la capacidad de ver ajenas nunca depende del nombre del rol)', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ email: 'practicante@example.com', role: 'asistente', permissions: PERMISSIONS.asistente, canSell: true });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(createResponse.status, 201);
  const response = await ventasHandler(fakeContext({ roleIdentity: ri, db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.ventas.length, 1);
  assert.equal(body.data.ventas[0].vendedorEmail, 'practicante@example.com');
});

test('GET /ventas/:id — un ejecutivo NO puede ver la venta de otro ejecutivo cambiando el id en la ruta (403/404, nunca los datos)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const b = roleIdentity({ email: 'ejecutivo.b@example.com' });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  // B intenta acceder a la venta de A cambiando el id en la ruta.
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: b, db, params: { id: created.id } }));
  assert.equal(response.status, 404, 'debe comportarse igual que "no existe" — nunca confirmar que la venta existe pero es ajena');
  const raw = JSON.stringify(await response.json());
  assert.doesNotMatch(raw, /Ferretería/); // el negocio del cliente de A no debe filtrarse.
});

test('GET /ventas/:id — el dueño de la venta sí puede verla', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: a, db, params: { id: created.id } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.venta.id, created.id);
  assert.equal(body.data.componentes.length, 1);
});

// RIO-118 (corrección — identidad visible, 01/09/2026): también aplica a
// quién informó/revisó cada entrega de materiales — nunca solo el email.
test('GET /ventas/:id — cada entrega de materiales incluye informadoPorNombre (y revisadoPorNombre si ya fue revisada) resueltos desde D1', async () => {
  const db = fakeDb();
  db._state.usuarios.push({ id: 99, email: 'ejecutivo.a@example.com', nombre: 'Juan Herrera' });
  db._state.usuarios.push({ id: 98, email: 'admin@example.com', nombre: 'Brenda Rivera' });
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;
  const detalleInicial = await (await ventaDetailHandler(fakeContext({ roleIdentity: a, db, params: { id: created.id } }))).json();
  const componenteId = detalleInicial.data.componentes[0].id;

  db._state.materiales_informados_detalle.push({
    id: 'e1', componente_id: componenteId, informado_por: 'ejecutivo.a@example.com',
    elementos_json: '[]', observaciones: null, numero_entrega: 1, descripcion: 'Fotos.',
    cantidad_archivos_aprox: null, correo_destino: 'venta@rioimpulsodigital.com',
    estado_revision: 'aceptada', revisado_por: 'admin@example.com', revisado_en: '2026-09-02 10:00:00',
    motivo_revision: null, created_at: '2026-09-01 09:00:00',
  });

  const response = await ventaDetailHandler(fakeContext({ roleIdentity: a, db, params: { id: created.id } }));
  const body = await response.json();
  const informe = body.data.componentes[0].materialesInformes[0];
  assert.equal(informe.informadoPor, 'ejecutivo.a@example.com');
  assert.equal(informe.informadoPorNombre, 'Juan Herrera');
  assert.equal(informe.revisadoPor, 'admin@example.com');
  assert.equal(informe.revisadoPorNombre, 'Brenda Rivera');
});

test('GET /ventas/:id — un supervisor de OTRO mercado no puede ver la venta (aislamiento entre mercados)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  const supervisorAr = roleIdentity({ email: 'supervisor.ar@example.com', role: 'supervisor', allowedMarkets: ['AR'], permissions: PERMISSIONS.supervisor });
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: supervisorAr, db, params: { id: created.id } }));
  assert.equal(response.status, 404);
});

test('GET /ventas/:id — un supervisor VIGENTE del equipo de esta venta sí puede verla', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'ejecutivo.cl@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'supervisor.cl@example.com', valid_until: null });
  const a = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  const supervisorCl = roleIdentity({ email: 'supervisor.cl@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: supervisorCl, db, params: { id: created.id } }));
  assert.equal(response.status, 200);
});

test('GET /ventas/:id — un supervisor del MISMO mercado pero de OTRO equipo NO puede ver la venta, ni manipulando el id (RIO-118: "mercado no equivale a equipo")', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'ejecutivo.cl@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-2', usuario_email: 'supervisor.ajeno@example.com', valid_until: null }); // supervisa OTRO equipo del mismo mercado.
  const a = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  const supervisorAjeno = roleIdentity({ email: 'supervisor.ajeno@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: supervisorAjeno, db, params: { id: created.id } }));
  assert.equal(response.status, 404, 'mismo criterio de siempre: no se distingue "no existe" de "no autorizado"');
});

test('GET /ventas/:id — un supervisor del mismo mercado NO recibe datos tributarios/de facturación ni la categoría "facturacion" de los antecedentes del Kit', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-ar-1', usuario_email: 'ejecutivo.ar@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-ar-1', usuario_email: 'supervisor.ar@example.com', valid_until: null });
  const a = roleIdentity({ email: 'ejecutivo.ar@example.com', allowedMarkets: ['AR'] });
  const AR_CON_FACTURACION = {
    mercado: 'AR', cliente: { negocio: 'Estudio Uñas', datosFacturacionAr: 'Razón social: Uñas SRL | CUIT: 20-12345678-9' },
    producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 125000,
    antecedentesKit: { diagnosticoComercial: null, datosLanding: null, datosFicha: null, facturacion: { 'CUIT/CUIL/DNI': '20-12345678-9' }, productoCondiciones: { 'Forma de pago': 'Transferencia bancaria' } },
  };
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: AR_CON_FACTURACION, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  const supervisorAr = roleIdentity({ email: 'supervisor.ar@example.com', role: 'supervisor', allowedMarkets: ['AR'], permissions: PERMISSIONS.supervisor });
  const responseSupervisor = await ventaDetailHandler(fakeContext({ roleIdentity: supervisorAr, db, params: { id: created.id } }));
  assert.equal(responseSupervisor.status, 200);
  const bodySupervisor = await responseSupervisor.json();
  assert.equal(bodySupervisor.data.cliente.datosFacturacionAr, null, 'un supervisor nunca ve CUIT/domicilio/condición fiscal automáticamente');
  assert.equal(bodySupervisor.data.venta.antecedentesKit.facturacion, undefined, 'la categoría "facturacion" desaparece para el supervisor');
  assert.ok(bodySupervisor.data.venta.antecedentesKit.productoCondiciones, 'el resto de las categorías sigue visible');

  // El dueño de la venta y un admin sí ven todo.
  const responseDueño = await ventaDetailHandler(fakeContext({ roleIdentity: a, db, params: { id: created.id } }));
  const bodyDueño = await responseDueño.json();
  assert.equal(bodyDueño.data.cliente.datosFacturacionAr, 'Razón social: Uñas SRL | CUIT: 20-12345678-9');
  assert.ok(bodyDueño.data.venta.antecedentesKit.facturacion);

  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const responseAdmin = await ventaDetailHandler(fakeContext({ roleIdentity: admin, db, params: { id: created.id } }));
  const bodyAdmin = await responseAdmin.json();
  assert.equal(bodyAdmin.data.cliente.datosFacturacionAr, 'Razón social: Uñas SRL | CUIT: 20-12345678-9');
  assert.ok(bodyAdmin.data.venta.antecedentesKit.facturacion);
});

test('GET /ventas/:id — id inexistente devuelve 404 igual para cualquier rol', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: admin, db, params: { id: 'no-existe' } }));
  assert.equal(response.status, 404);
});

test('método no permitido en /ventas (DELETE) — 405', async () => {
  const db = fakeDb();
  const response = await ventasHandler(fakeContext({ method: 'DELETE', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 405);
});

test('un cambio posterior en el precio canónico (markets.js) NO altera una venta ya registrada (snapshot inmutable)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const precioOriginal = MARKETS.CL.products.ficha.promo;

  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).data.venta;
  assert.equal(created.precioPactado, precioOriginal);

  // Simula que el precio canónico cambió después de registrada la venta
  // (ej. una nueva campaña) — mutamos el mismo objeto MARKETS importado
  // que usa pricing.js, sin tocar la venta ya guardada.
  const backup = MARKETS.CL.products.ficha.promo;
  MARKETS.CL.products.ficha.promo = precioOriginal + 12345;
  try {
    const detailResponse = await ventaDetailHandler(fakeContext({ roleIdentity: a, db, params: { id: created.id } }));
    const detailBody = await detailResponse.json();
    assert.equal(detailBody.data.venta.precioPactado, precioOriginal, 'la venta histórica debe conservar el precio con el que se pactó, no el nuevo precio canónico');
    assert.notEqual(detailBody.data.venta.precioPactado, MARKETS.CL.products.ficha.promo);
  } finally {
    MARKETS.CL.products.ficha.promo = backup; // no contaminar otras pruebas.
  }
});

// RIO-118 (corrección — ventas administrativas y comisión de supervisión,
// 02/09/2026): la comisión de supervisión depende de que la venta esté
// vinculada a un EQUIPO SUPERVISADO, nunca del rol principal ni del nombre
// de quien vende. Administración elige explícitamente entre un equipo
// autorizado o "venta directa — sin supervisión"; cualquier otro rol
// siempre resuelve su equipo desde su propia asignación vigente.

test('POST /ventas — administración registra una venta directa sin supervisión: no genera comisión de supervisor y empresa queda con el 30% completo', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL'], permissions: PERMISSIONS.admin });
  seedAsignacionPlan(db, { email: admin.email, tipo: 'comercial', porcentaje: 40 });
  const response = await ventasHandler(fakeContext({
    method: 'POST',
    body: { ...CL_INDIVIDUAL, tipoVenta: 'directa_administracion_sin_supervision' },
    roleIdentity: admin, db,
  }));
  assert.equal(response.status, 201);
  const venta = (await response.json()).data.venta;
  assert.equal(venta.tipoVenta, 'directa_administracion_sin_supervision');
  assert.equal(venta.equipoId, null);
  assert.equal(venta.supervisionAplica, false);
  assert.equal(venta.motivoSinSupervision, 'venta_directa_administracion_sin_supervision');
  assert.equal(db._state.ventas[0].porcentaje_supervision_aplicado, 0);
  assert.equal(db._state.ventas[0].porcentaje_final_empresa, 30, 'el 10% liberado va explícitamente a empresa, nunca desaparece ni se redistribuye');
  assert.equal(db._state.comisiones.filter((c) => c.tipo === 'supervision').length, 0, 'ninguna comisión de supervisión debe generarse');
});

test('POST /ventas — administración asigna su venta a un equipo supervisado: se genera el 10% para el supervisor vigente, aunque quien venda sea administración', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL'], permissions: PERMISSIONS.admin });
  seedAsignacionPlan(db, { email: admin.email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'alberto@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.equipos.push({ id: 'equipo-cl-1', mercado: 'CL' });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', valid_until: null });

  const response = await ventasHandler(fakeContext({
    method: 'POST',
    body: { ...CL_INDIVIDUAL, tipoVenta: 'equipo', equipoId: 'equipo-cl-1' },
    roleIdentity: admin, db,
  }));
  assert.equal(response.status, 201);
  const venta = (await response.json()).data.venta;
  assert.equal(venta.equipoId, 'equipo-cl-1');
  assert.equal(venta.supervisionAplica, true);
  assert.equal(venta.motivoSinSupervision, null);
  assert.equal(db._state.ventas[0].porcentaje_final_empresa, 20);
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.ok(supervision, 'debe generarse la comisión de supervisión para Alberto, aunque quien vende sea administración y no un vendedor del equipo');
  assert.equal(supervision.beneficiario_email, 'alberto@example.com');
});

test('POST /ventas — administración sin tipoVenta explícito es rechazada (nunca un default silencioso)', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL'], permissions: PERMISSIONS.admin });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: admin, db }));
  assert.equal(response.status, 400);
  assert.equal(db._state.ventas.length, 0);
});

test('POST /ventas — administración: un equipoId de otro mercado es rechazado, cambiar el payload no logra alterar la distribución', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  db._state.equipos.push({ id: 'equipo-ar-1', mercado: 'AR' });
  const response = await ventasHandler(fakeContext({
    method: 'POST',
    body: { ...CL_INDIVIDUAL, tipoVenta: 'equipo', equipoId: 'equipo-ar-1' },
    roleIdentity: admin, db,
  }));
  assert.equal(response.status, 400);
  assert.equal(db._state.ventas.length, 0, 'no debe registrarse ninguna venta con un equipo de otro mercado');
});

test('POST /ventas — un vendedor común no puede elegir un equipo ajeno: tipoVenta/equipoId enviados en el body se ignoran, su equipo se resuelve siempre desde su asignación vigente', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  seedAsignacionPlan(db, { email: ri.email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: 'supervisor.propio@example.com', tipo: 'supervision', porcentaje: 10 });
  const equipoPropio = seedEquipo(db, { mercado: 'CL', miembroEmail: ri.email, supervisorEmail: 'supervisor.propio@example.com' });
  db._state.equipos.push({ id: equipoPropio, mercado: 'CL' });
  db._state.equipos.push({ id: 'equipo-ajeno', mercado: 'CL' });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-ajeno', usuario_email: 'supervisor.ajeno@example.com', valid_until: null });

  const response = await ventasHandler(fakeContext({
    method: 'POST',
    body: { ...CL_INDIVIDUAL, tipoVenta: 'directa_administracion_sin_supervision', equipoId: 'equipo-ajeno' },
    roleIdentity: ri, db,
  }));
  assert.equal(response.status, 201);
  const venta = (await response.json()).data.venta;
  assert.equal(venta.equipoId, equipoPropio, 'debe usar su propio equipo vigente, nunca el equipoId recibido en el body');
  assert.equal(venta.tipoVenta, 'equipo', 'un vendedor común nunca puede declarar una venta directa de administración');
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.ok(supervision);
  assert.equal(supervision.beneficiario_email, 'supervisor.propio@example.com', 'nunca el supervisor del equipo ajeno recibido en el body');
});

test('POST /ventas — un supervisor que vende dentro de su propio equipo recibe comercial y supervisión como participaciones separadas', async () => {
  const db = fakeDb();
  const alberto = roleIdentity({ email: 'alberto@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  seedAsignacionPlan(db, { email: alberto.email, tipo: 'comercial', porcentaje: 40 });
  seedAsignacionPlan(db, { email: alberto.email, tipo: 'supervision', porcentaje: 10 });
  seedEquipo(db, { equipoId: 'equipo-alberto', mercado: 'CL', miembroEmail: alberto.email, supervisorEmail: alberto.email });

  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: alberto, db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comisiones.length, 2, 'dos participaciones separadas, nunca fusionadas en una sola fila');
  const comercial = db._state.comisiones.find((c) => c.tipo === 'comercial');
  const supervision = db._state.comisiones.find((c) => c.tipo === 'supervision');
  assert.equal(comercial.beneficiario_email, alberto.email);
  assert.equal(supervision.beneficiario_email, alberto.email);
  assert.equal(comercial.monto_comision, 20000);
  assert.equal(supervision.monto_comision, 5000);
});

test('GET /ventas/:id — un vendedor sin equipo asignado expone un estado visible ("equipo no asignado"), nunca ausencia silenciosa del dato', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  const created = (await createResponse.json()).data.venta;
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: ri, db, params: { id: created.id } }));
  const venta = (await response.json()).data.venta;
  assert.equal(venta.equipoId, null);
  assert.equal(venta.tipoVenta, 'equipo', 'default estructural — distinto de una venta directa deliberada');
  assert.equal(venta.motivoSinSupervision, null, 'sin motivo: es un vacío estructural, no una elección de administración');
  assert.equal(venta.supervisorNombre, null);
});

test('GET /ventas/:id — una venta directa de administración expone su motivo explícito, distinguible de "equipo no asignado"', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL'], permissions: PERMISSIONS.admin });
  const createResponse = await ventasHandler(fakeContext({
    method: 'POST', body: { ...CL_INDIVIDUAL, tipoVenta: 'directa_administracion_sin_supervision' }, roleIdentity: admin, db,
  }));
  const created = (await createResponse.json()).data.venta;
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: admin, db, params: { id: created.id } }));
  const venta = (await response.json()).data.venta;
  assert.equal(venta.tipoVenta, 'directa_administracion_sin_supervision');
  assert.equal(venta.motivoSinSupervision, 'venta_directa_administracion_sin_supervision');
  assert.equal(venta.supervisionAplica, false);
});

test('GET /ventas/:id — una venta con supervisor expone el nombre del supervisor y del equipo', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  db._state.usuarios.push({ id: 999, email: 'supervisor.cl@example.com', nombre: 'Alberto Soto' });
  seedEquipo(db, { equipoId: 'equipo-cl-1', mercado: 'CL', miembroEmail: ri.email, supervisorEmail: 'supervisor.cl@example.com' });
  db._state.equipos.push({ id: 'equipo-cl-1', mercado: 'CL', nombre: 'Equipo CL 1' });

  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  const created = (await createResponse.json()).data.venta;
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: ri, db, params: { id: created.id } }));
  const venta = (await response.json()).data.venta;
  assert.equal(venta.equipoNombre, 'Equipo CL 1');
  assert.equal(venta.supervisorNombre, 'Alberto Soto');
});

test('el supervisor snapshotteado en una venta no cambia si el equipo cambia de supervisor vigente después (snapshot inmutable)', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  db._state.usuarios.push({ id: 901, email: 'alberto@example.com', nombre: 'Alberto Soto' });
  db._state.usuarios.push({ id: 902, email: 'nuevo.supervisor@example.com', nombre: 'Nueva Supervisora' });
  seedAsignacionPlan(db, { email: 'alberto@example.com', tipo: 'supervision', porcentaje: 10 });
  const equipoId = seedEquipo(db, { mercado: 'CL', miembroEmail: ri.email, supervisorEmail: 'alberto@example.com' });
  db._state.equipos.push({ id: equipoId, mercado: 'CL', nombre: 'Equipo CL' });

  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  const created = (await createResponse.json()).data.venta;

  // El equipo cambia de supervisor DESPUÉS de cerrada la venta — nunca debe
  // alterar el snapshot ya guardado (misma lógica que el precio canónico).
  db._state.equipo_supervisores.find((s) => s.equipo_id === equipoId && s.usuario_email === 'alberto@example.com').valid_until = '2026-09-02';
  db._state.equipo_supervisores.push({ equipo_id: equipoId, usuario_email: 'nuevo.supervisor@example.com', valid_until: null });

  const response = await ventaDetailHandler(fakeContext({ roleIdentity: ri, db, params: { id: created.id } }));
  const venta = (await response.json()).data.venta;
  assert.equal(venta.supervisorEmail, 'alberto@example.com', 'la venta histórica conserva el supervisor con el que se cerró, no el vigente actual');
  assert.equal(venta.supervisorNombre, 'Alberto Soto');
});

test('GET /ventas — el listado (no solo el detalle) expone equipoNombre y supervisorNombre, para filtrar sin una consulta extra por fila (RIO-119)', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  db._state.usuarios.push({ id: 950, email: 'supervisor.cl@example.com', nombre: 'Alberto Soto' });
  seedEquipo(db, { equipoId: 'equipo-cl-1', mercado: 'CL', miembroEmail: ri.email, supervisorEmail: 'supervisor.cl@example.com' });
  db._state.equipos.push({ id: 'equipo-cl-1', mercado: 'CL', nombre: 'Equipo CL 1' });

  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL'], permissions: PERMISSIONS.admin });
  const response = await ventasHandler(fakeContext({ roleIdentity: admin, db }));
  const body = await response.json();
  assert.equal(body.data.ventas.length, 1);
  assert.equal(body.data.ventas[0].equipoNombre, 'Equipo CL 1');
  assert.equal(body.data.ventas[0].supervisorNombre, 'Alberto Soto');
});

test('la suma efectiva de porcentajes (supervisión + empresa) siempre es 30, con o sin supervisión aplicada', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL'], permissions: PERMISSIONS.admin });
  seedAsignacionPlan(db, { email: 'alberto@example.com', tipo: 'supervision', porcentaje: 10 });
  db._state.equipos.push({ id: 'equipo-cl-1', mercado: 'CL' });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', valid_until: null });

  const conSupervision = await ventasHandler(fakeContext({
    method: 'POST', body: { ...CL_INDIVIDUAL, tipoVenta: 'equipo', equipoId: 'equipo-cl-1' }, roleIdentity: admin, db,
  }));
  const ventaConSupervision = (await conSupervision.json()).data.venta;
  assert.equal(db._state.ventas.find((v) => v.id === ventaConSupervision.id).porcentaje_supervision_aplicado + db._state.ventas.find((v) => v.id === ventaConSupervision.id).porcentaje_final_empresa, 30);

  const sinSupervision = await ventasHandler(fakeContext({
    method: 'POST', body: { ...CL_INDIVIDUAL, tipoVenta: 'directa_administracion_sin_supervision' }, roleIdentity: admin, db,
  }));
  const ventaSinSupervision = (await sinSupervision.json()).data.venta;
  assert.equal(db._state.ventas.find((v) => v.id === ventaSinSupervision.id).porcentaje_supervision_aplicado + db._state.ventas.find((v) => v.id === ventaSinSupervision.id).porcentaje_final_empresa, 30);
});
