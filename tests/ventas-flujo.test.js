// Pruebas de las rutas de flujo de RIO-113 — autorización y aislamiento,
// actualizadas para las decisiones definitivas de Brenda del 28/08/2026
// (permisos por CAPACIDAD, no por rol; vendedor_email genérico; reporte
// vs. validación vs. modificación oficial). La lógica de negocio (gate,
// transiciones, pagos) ya se prueba a fondo en tests/proyectos.test.js —
// acá se prueba que cada ruta exige el permiso correcto según quién es
// el vendedor de la venta, no según el nombre del rol.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as componenteHandler } from '../functions/interno/api/ventas/[id]/componentes/[componenteId]/index.js';
import { onRequest as pagoHandler } from '../functions/interno/api/ventas/[id]/pagos/[pagoId]/index.js';
import { onRequest as incidenciasHandler } from '../functions/interno/api/ventas/[id]/incidencias.js';
import { onRequest as historialHandler } from '../functions/interno/api/ventas/[id]/historial.js';
import { onRequest as antecedentesHandler } from '../functions/interno/api/ventas/[id]/antecedentes.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

const VENDEDOR = 'vendedor.a@example.com';

function roleIdentity(overrides = {}) {
  return {
    email: VENDEDOR,
    role: 'ejecutivo',
    allowedMarkets: ['CL'],
    canSell: true,
    permissions: PERMISSIONS.ejecutivo,
    ...overrides,
  };
}

// D1 simulado: una venta fija ('venta-1'), vendida por VENDEDOR en
// mercado CL, con un proyecto, un componente ('comp-x') y un pago
// esperado ('pago-x') — suficiente para ejercitar cada acción real de
// proyectos.js a través de las rutas, sin repetir la cobertura de
// negocio ya completa en tests/proyectos.test.js.
function fakeDb({ ventaExiste = true } = {}) {
  const state = {
    ventas: ventaExiste ? [{ id: 'venta-1', vendedor_email: VENDEDOR, mercado: 'CL' }] : [],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1', estado_actual: 'registrado' }],
    componentes: [{ id: 'comp-x', proyecto_id: 'proyecto-1', tipo: 'ficha', estado_actual: 'entregada', materiales_estado: 'pendiente' }],
    pagos_esperados: [{ id: 'pago-x', venta_id: 'venta-1', tipo: 'total', monto: 50000, estado: 'pendiente' }],
    pagos_informados: [],
    acreditaciones: [],
    eventos_historial: [],
    incidencias: [],
    materiales_informados_detalle: [],
    materiales_confirmaciones: [],
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
    if (sql.startsWith('SELECT * FROM eventos_historial')) return state.eventos_historial;
    if (
      sql.startsWith('SELECT id, vendedor_email, mercado FROM ventas')
      || sql.startsWith('SELECT * FROM ventas WHERE id')
      || sql.startsWith('SELECT id FROM ventas WHERE id')
    ) {
      return state.ventas.filter((v) => v.id === p[0]);
    }
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) return state.componentes.filter((c) => c.proyecto_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((x) => x.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_informados WHERE pago_esperado_id')) {
      return state.pagos_informados.filter((x) => x.pago_esperado_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    return [];
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6], motivo_nota: p[7], proxima_accion: p[8], responsable_proxima_accion: p[9] });
    } else if (sql.startsWith('UPDATE componentes SET estado_actual')) {
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
      state.pagos_informados.push({ id: p[0], pago_esperado_id: p[1], monto_informado: p[2], informado_por: p[3], comprobante_nota: p[4] });
    } else if (sql.startsWith("UPDATE pagos_esperados SET estado = 'informado'")) {
      const pago = state.pagos_esperados.find((x) => x.id === p[0]);
      if (pago) pago.estado = 'informado';
    } else if (sql.startsWith("UPDATE pagos_esperados SET estado = 'acreditado'")) {
      const pago = state.pagos_esperados.find((x) => x.id === p[0]);
      if (pago) pago.estado = 'acreditado';
    } else if (sql.startsWith('INSERT INTO acreditaciones')) {
      state.acreditaciones.push({ id: p[0], pago_informado_id: p[1], monto_acreditado: p[2], verificado_por: p[3], nota: p[4] });
    } else if (sql.startsWith('INSERT INTO incidencias')) {
      state.incidencias.push({ id: p[0], venta_id: p[1], tipo: p[2], motivo: p[3], estado: 'abierta', registrado_por: p[4] });
    } else if (sql.startsWith('INSERT INTO materiales_informados_detalle')) {
      state.materiales_informados_detalle.push({ id: p[0], componente_id: p[1], informado_por: p[2], elementos_json: p[3], observaciones: p[4] });
    } else if (sql.startsWith('INSERT INTO materiales_confirmaciones')) {
      state.materiales_confirmaciones.push({ id: p[0], componente_id: p[1], admin_email: p[2], resultado: p[3], faltantes_json: p[4] || null });
    }
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'POST', body, roleIdentity: ri, db, params = { id: 'venta-1' } }) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas/venta-1/x', init),
    env: { DB: db },
    params,
    data: { requestId: 'req-flujo-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

// --- Vendedor (dueño de la venta, cualquier rol) ---

test('componentes: el vendedor de la venta puede reportar materiales-informados', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-informados' }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-x').materiales_estado, 'informados');
});

test('componentes: materiales-informados registra elementos/observaciones/quién/cuándo, aparte de mover el estado', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({
    body: { action: 'materiales-informados', elementos: ['logo', 'fotos'], observaciones: 'Llegaron por WhatsApp.' },
    roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' },
  }));
  assert.equal(response.status, 200);
  const detalle = db._state.materiales_informados_detalle[0];
  assert.equal(detalle.componente_id, 'comp-x');
  assert.equal(detalle.informado_por, VENDEDOR);
  assert.deepEqual(JSON.parse(detalle.elementos_json), ['logo', 'fotos']);
  assert.equal(detalle.observaciones, 'Llegaron por WhatsApp.');
});

test('componentes: informar materiales dos veces seguidas (sin que administración confirme entre medio) se rechaza — nunca se pisa el informe anterior', async () => {
  const db = fakeDb();
  await componenteHandler(fakeContext({ body: { action: 'materiales-informados', elementos: ['logo'] }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-informados', elementos: ['fotos'] }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 409);
  assert.equal(db._state.materiales_informados_detalle.length, 1, 'el segundo intento no agrega un registro nuevo');
});

test('componentes: administración marca materiales-incompletos — vuelve a pendiente y deja auditoría de lo que falta, sin borrar el informe del vendedor', async () => {
  const db = fakeDb();
  await componenteHandler(fakeContext({ body: { action: 'materiales-informados', elementos: ['logo'] }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-incompletos', faltantes: ['fotos', 'textos'] }, roleIdentity: admin, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-x').materiales_estado, 'pendiente');
  assert.equal(db._state.materiales_informados_detalle.length, 1, 'el informe original del vendedor sigue existiendo');
  const confirmacion = db._state.materiales_confirmaciones[0];
  assert.equal(confirmacion.resultado, 'incompletos');
  assert.deepEqual(JSON.parse(confirmacion.faltantes_json), ['fotos', 'textos']);

  // El vendedor puede volver a informar — un nuevo registro, no un reemplazo.
  const segundo = await componenteHandler(fakeContext({ body: { action: 'materiales-informados', elementos: ['fotos', 'textos'] }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(segundo.status, 200);
  assert.equal(db._state.materiales_informados_detalle.length, 2);
});

test('componentes: el vendedor de la venta recibe 403 al intentar una transición oficial (aprobar) — incluso siendo el dueño', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 403);
});

test('componentes: el vendedor de la venta recibe 403 al intentar confirmar materiales-completos (validación oficial, exclusiva de admin)', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-completos' }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 403);
});

test('componentes: un ejecutivo que NO es dueño de la venta recibe 404 (no filtra si existe o no)', async () => {
  const db = fakeDb();
  const otro = roleIdentity({ email: 'ejecutivo.b@example.com' });
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-informados' }, roleIdentity: otro, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 404);
});

test('componentes: action inválida devuelve 400 de validación', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({ body: { action: 'volar' }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 400);
});

test('pagos: el vendedor de la venta SÍ puede informar su propio pago', async () => {
  const db = fakeDb();
  const response = await pagoHandler(fakeContext({ body: { action: 'informar', montoInformado: 50000 }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.pagos_esperados.find((p) => p.id === 'pago-x').estado, 'informado');
});

test('pagos: acreditar sin ser admin devuelve 403, incluso siendo el vendedor dueño de la venta', async () => {
  const db = fakeDb();
  const response = await pagoHandler(fakeContext({ body: { action: 'acreditar', montoAcreditado: 1000 }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(response.status, 403);
});

test('antecedentes: el vendedor de la venta puede agregar un antecedente u observación', async () => {
  const db = fakeDb();
  const response = await antecedentesHandler(fakeContext({ body: { nota: 'El cliente pidió cambiar el logo.' }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 201);
  assert.ok(db._state.eventos_historial.some((e) => e.entidad === 'venta' && e.estado_nuevo === 'antecedente'));
});

// --- Supervisor puro (no es el vendedor de esta venta) ---

function supervisorMismoMercado(overrides = {}) {
  return roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', allowedMarkets: ['CL'], canSell: false, permissions: PERMISSIONS.supervisor, ...overrides });
}

test('componentes: un supervisor de SU mercado (no vendedor) puede VER la venta pero recibe 403 al reportar materiales ajenos', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-informados' }, roleIdentity: supervisorMismoMercado(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 403, 'la venta es visible para el supervisor (mismo mercado), pero reportar materiales ajenos no es capacidad de supervisión pura');
});

test('componentes: un supervisor recibe 403 al intentar una transición oficial sobre una venta ajena de su mercado', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: supervisorMismoMercado(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 403);
});

test('pagos: un supervisor recibe 403 al informar un pago ajeno, aunque sea de su mismo mercado', async () => {
  const db = fakeDb();
  const response = await pagoHandler(fakeContext({ body: { action: 'informar', montoInformado: 1000 }, roleIdentity: supervisorMismoMercado(), db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(response.status, 403);
});

test('pagos: un supervisor recibe 403 al acreditar (exclusivo de admin)', async () => {
  const db = fakeDb();
  const response = await pagoHandler(fakeContext({ body: { action: 'acreditar', montoAcreditado: 1000 }, roleIdentity: supervisorMismoMercado(), db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(response.status, 403);
});

test('componentes: un supervisor NUNCA puede confirmar materiales (ni completos ni incompletos) — exclusivo de administración', async () => {
  const db = fakeDb();
  const completos = await componenteHandler(fakeContext({ body: { action: 'materiales-completos' }, roleIdentity: supervisorMismoMercado(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(completos.status, 403);
  const incompletos = await componenteHandler(fakeContext({ body: { action: 'materiales-incompletos', faltantes: ['fotos'] }, roleIdentity: supervisorMismoMercado(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(incompletos.status, 403);
});

test('componentes: un supervisor de OTRO mercado recibe 404 (la venta ni siquiera es visible)', async () => {
  const db = fakeDb();
  const otroMercado = supervisorMismoMercado({ allowedMarkets: ['AR'] });
  const response = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: otroMercado, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 404);
});

test('antecedentes: un supervisor sin ser el vendedor recibe 403 al intentar agregar un antecedente ajeno', async () => {
  const db = fakeDb();
  const response = await antecedentesHandler(fakeContext({ body: { nota: 'observación ajena' }, roleIdentity: supervisorMismoMercado(), db }));
  assert.equal(response.status, 403);
});

// --- Supervisor que también vende (can_sell + vendedor_email = su email) ---

test('supervisor vendedor: sobre SU PROPIA venta puede reportar materiales e informar pagos, pero sigue sin poder validar/aprobar oficialmente', async () => {
  const db = fakeDb();
  const supervisorVendedor = roleIdentity({ email: 'supervisor.vende@example.com', role: 'supervisor', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.supervisor });
  db._state.ventas[0].vendedor_email = supervisorVendedor.email; // esta venta es SUYA.

  const reportar = await componenteHandler(fakeContext({ body: { action: 'materiales-informados' }, roleIdentity: supervisorVendedor, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(reportar.status, 200, 'sobre su propia venta, sí puede reportar materiales');

  const informar = await pagoHandler(fakeContext({ body: { action: 'informar', montoInformado: 1000 }, roleIdentity: supervisorVendedor, db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(informar.status, 200, 'sobre su propia venta, sí puede informar el pago');

  const acreditar = await pagoHandler(fakeContext({ body: { action: 'acreditar', montoAcreditado: 1000 }, roleIdentity: supervisorVendedor, db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(acreditar.status, 403, 'acreditar sigue siendo exclusivo de admin, incluso en su propia venta');

  const aprobar = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: supervisorVendedor, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(aprobar.status, 403, 'aprobar oficialmente sigue siendo exclusivo de admin, incluso en su propia venta');
});

// --- Asistente/practicante vendedor ---

test('asistente vendedor: sobre su propia venta puede reportar, pero no acreditar ni modificar avances oficiales', async () => {
  const db = fakeDb();
  const asistenteVendedor = roleIdentity({ email: 'practicante@example.com', role: 'asistente', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.asistente });
  db._state.ventas[0].vendedor_email = asistenteVendedor.email;

  const reportar = await componenteHandler(fakeContext({ body: { action: 'materiales-informados' }, roleIdentity: asistenteVendedor, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(reportar.status, 200);

  const aprobar = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: asistenteVendedor, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(aprobar.status, 403);

  const acreditar = await pagoHandler(fakeContext({ body: { action: 'acreditar', montoAcreditado: 1000 }, roleIdentity: asistenteVendedor, db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(acreditar.status, 403);
});

// --- Administrador ---

function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], canSell: true, permissions: PERMISSIONS.admin, ...overrides });
}

test('admin: puede confirmar materiales-completos, iniciar producción y aprobar, sobre una venta ajena de su mercado', async () => {
  const db = fakeDb();
  const materiales = await componenteHandler(fakeContext({ body: { action: 'materiales-completos' }, roleIdentity: admin(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(materiales.status, 200);

  const aprobar = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: admin(), db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(aprobar.status, 200);
});

test('admin: puede acreditar un pago ya informado, sobre una venta ajena de su mercado', async () => {
  const db = fakeDb();
  await pagoHandler(fakeContext({ body: { action: 'informar', montoInformado: 50000 }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  const acreditar = await pagoHandler(fakeContext({ body: { action: 'acreditar', montoAcreditado: 50000 }, roleIdentity: admin(), db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(acreditar.status, 200);
  assert.equal(db._state.pagos_esperados.find((p) => p.id === 'pago-x').estado, 'acreditado');
});

test('pack: los materiales de Landing se pueden informar y confirmar completos MIENTRAS la Ficha todavía está en producción (secuencia independiente)', async () => {
  const db = fakeDb();
  // La Ficha (comp-x) queda 'entregada' por defecto en este fakeDb — todavía
  // no aprobada. Se agrega la Landing del mismo pack, bloqueada, sin tocar
  // el estado de la Ficha en ningún momento de este test.
  db._state.componentes.push({ id: 'comp-landing', proyecto_id: 'proyecto-1', tipo: 'landing', estado_actual: 'bloqueada', materiales_estado: 'pendiente' });

  const informar = await componenteHandler(fakeContext({ body: { action: 'materiales-informados', elementos: ['fotos'] }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'comp-landing' } }));
  assert.equal(informar.status, 200);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').materiales_estado, 'informados');
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-x').estado_actual, 'entregada', 'la Ficha no se tocó');

  const completos = await componenteHandler(fakeContext({ body: { action: 'materiales-completos' }, roleIdentity: admin(), db, params: { id: 'venta-1', componenteId: 'comp-landing' } }));
  assert.equal(completos.status, 200);
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').materiales_estado, 'completos');
  // La Landing sigue bloqueada igual (todavía faltan Ficha aprobada + saldo
  // acreditado) — materiales completos es solo UNA de las 3 condiciones.
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-landing').estado_actual, 'bloqueada');
  assert.equal(db._state.componentes.find((c) => c.id === 'comp-x').estado_actual, 'entregada', 'la Ficha sigue sin tocarse');
});

test('admin: respeta igualmente sus propios mercados autorizados — 404 fuera de ellos', async () => {
  const db = fakeDb();
  const adminSoloAr = admin({ allowedMarkets: ['AR'] }); // esta venta es de mercado CL.
  const response = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: adminSoloAr, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 404);
});

// --- Incidencias (ya cubierto en detalle, se conserva) ---

test('incidencias: un ejecutivo NO puede registrar una cancelación (solo admin)', async () => {
  const db = fakeDb();
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'cancelacion', motivo: 'prueba' }, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('incidencias: un supervisor tampoco puede (solo admin, no supervisor)', async () => {
  const db = fakeDb();
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'disputa', motivo: 'prueba' }, roleIdentity: supervisorMismoMercado(), db }));
  assert.equal(response.status, 403);
});

test('incidencias: un admin SÍ puede registrar una disputa', async () => {
  const db = fakeDb();
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'disputa', motivo: 'Cliente reclama' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 201);
});

test('incidencias: tipo inválido se rechaza incluso para admin', async () => {
  const db = fakeDb();
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'algo_raro', motivo: 'x' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

// --- Historial (lectura — sin cambios de permiso) ---

test('historial: un ejecutivo ajeno a la venta recibe 404, no la lista de eventos', async () => {
  const db = fakeDb();
  const otro = roleIdentity({ email: 'ejecutivo.b@example.com' });
  const response = await historialHandler(fakeContext({ method: 'GET', roleIdentity: otro, db }));
  assert.equal(response.status, 404);
});

test('historial: el vendedor dueño de la venta puede consultarlo', async () => {
  const db = fakeDb();
  const response = await historialHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.data.eventos));
});

test('historial: un supervisor de su mismo mercado puede consultarlo aunque no sea el vendedor (capacidad de supervisión es de lectura)', async () => {
  const db = fakeDb();
  const response = await historialHandler(fakeContext({ method: 'GET', roleIdentity: supervisorMismoMercado(), db }));
  assert.equal(response.status, 200);
});

// --- Seguridad: venta inexistente, método no permitido, cambio de id/payload ---

test('venta inexistente: cualquier ruta anidada devuelve 404, para cualquier rol', async () => {
  const db = fakeDb({ ventaExiste: false });
  const r1 = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: admin(), db, params: { id: 'no-existe', componenteId: 'x' } }));
  assert.equal(r1.status, 404);
  const r2 = await historialHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { id: 'no-existe' } }));
  assert.equal(r2.status, 404);
  const r3 = await antecedentesHandler(fakeContext({ body: { nota: 'x' }, roleIdentity: admin(), db, params: { id: 'no-existe' } }));
  assert.equal(r3.status, 404);
});

test('método no permitido en las rutas de acción (GET en vez de POST) — 405', async () => {
  const db = fakeDb();
  const response = await componenteHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db, params: { id: 'venta-1', componenteId: 'x' } }));
  assert.equal(response.status, 405);
});

test('cambiar el id de la venta en la ruta no permite eludir permisos: un ejecutivo ajeno sigue recibiendo 404 sin importar el componenteId que use', async () => {
  const db = fakeDb();
  const otro = roleIdentity({ email: 'ejecutivo.b@example.com' });
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-informados' }, roleIdentity: otro, db, params: { id: 'venta-1', componenteId: 'cualquier-id-inventado' } }));
  assert.equal(response.status, 404);
});
