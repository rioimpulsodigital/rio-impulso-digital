// Pruebas de las rutas de flujo de RIO-113 — autorización y aislamiento.
// La lógica de negocio (gate, transiciones, pagos) ya se prueba a fondo en
// tests/proyectos.test.js — acá se prueba que cada ruta exige el rol
// correcto y no permite acceso a la venta de otra persona.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as componenteHandler } from '../functions/interno/api/ventas/[id]/componentes/[componenteId]/index.js';
import { onRequest as pagoHandler } from '../functions/interno/api/ventas/[id]/pagos/[pagoId]/index.js';
import { onRequest as incidenciasHandler } from '../functions/interno/api/ventas/[id]/incidencias.js';
import { onRequest as historialHandler } from '../functions/interno/api/ventas/[id]/historial.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'ejecutivo.a@example.com',
    role: 'ejecutivo',
    allowedMarkets: ['CL'],
    permissions: PERMISSIONS.ejecutivo,
    ...overrides,
  };
}

// D1 simulado mínimo: una venta fija, propiedad de ejecutivo.a@example.com,
// mercado CL — suficiente para probar autorización sin ejercitar la
// máquina de estados completa (eso ya está en proyectos.test.js).
function fakeDb({ ventaExiste = true } = {}) {
  const eventos = [];
  return {
    _eventos: eventos,
    prepare(sql) {
      let p = [];
      return {
        bind(...params) { p = params; return this; },
        all: async () => {
          if (sql.startsWith('SELECT * FROM eventos_historial')) return { results: eventos };
          if (
            sql.startsWith('SELECT id, ejecutivo_email, mercado FROM ventas')
            || sql.startsWith('SELECT id FROM ventas')
            || sql.startsWith('SELECT * FROM ventas WHERE id')
          ) {
            return { results: ventaExiste ? [{ id: 'venta-1', ejecutivo_email: 'ejecutivo.a@example.com', mercado: 'CL' }] : [] };
          }
          return { results: [] };
        },
        first: async () => {
          if (sql.startsWith('SELECT id, ejecutivo_email, mercado FROM ventas') || sql.startsWith('SELECT id FROM ventas')) {
            return ventaExiste ? { id: 'venta-1', ejecutivo_email: 'ejecutivo.a@example.com', mercado: 'CL' } : null;
          }
          return null;
        },
        run: async () => {
          if (sql.startsWith('INSERT INTO incidencias') || sql.startsWith('INSERT INTO eventos_historial')) eventos.push({ id: p[0] });
          return { success: true };
        },
      };
    },
  };
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

test('componentes: un ejecutivo que NO es dueño de la venta recibe 404 (no filtra si existe o no)', async () => {
  const db = fakeDb();
  const otro = roleIdentity({ email: 'ejecutivo.b@example.com' });
  const response = await componenteHandler(fakeContext({ body: { action: 'materiales-completos' }, roleIdentity: otro, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 404);
});

test('componentes: action inválida devuelve 400 de validación', async () => {
  const db = fakeDb();
  const dueño = roleIdentity();
  const response = await componenteHandler(fakeContext({ body: { action: 'volar' }, roleIdentity: dueño, db, params: { id: 'venta-1', componenteId: 'comp-x' } }));
  assert.equal(response.status, 400);
});

test('pagos: acreditar sin ser admin devuelve 403, incluso siendo el dueño de la venta', async () => {
  const db = fakeDb();
  const dueño = roleIdentity(); // ejecutivo, no admin.
  const response = await pagoHandler(fakeContext({ body: { action: 'acreditar', montoAcreditado: 1000 }, roleIdentity: dueño, db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.equal(response.status, 403);
});

test('pagos: informar SÍ lo puede hacer el ejecutivo dueño (no requiere admin)', async () => {
  const db = fakeDb(); // pago-x no existe en este DB mínimo -> ProyectoError 'pago_no_encontrado' (404), nunca un bloqueo de rol (403).
  const dueño = roleIdentity();
  const response = await pagoHandler(fakeContext({ body: { action: 'informar', montoInformado: 1000 }, roleIdentity: dueño, db, params: { id: 'venta-1', pagoId: 'pago-x' } }));
  assert.notEqual(response.status, 403, 'informar un pago no debería requerir admin');
  assert.equal(response.status, 404); // el pago en sí no existe en este escenario mínimo — comportamiento correcto.
});

test('incidencias: un ejecutivo NO puede registrar una cancelación (solo admin)', async () => {
  const db = fakeDb();
  const dueño = roleIdentity();
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'cancelacion', motivo: 'prueba' }, roleIdentity: dueño, db }));
  assert.equal(response.status, 403);
});

test('incidencias: un supervisor tampoco puede (solo admin, no supervisor)', async () => {
  const db = fakeDb();
  const supervisor = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'disputa', motivo: 'prueba' }, roleIdentity: supervisor, db }));
  assert.equal(response.status, 403);
});

test('incidencias: un admin SÍ puede registrar una disputa', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'disputa', motivo: 'Cliente reclama' }, roleIdentity: admin, db }));
  assert.equal(response.status, 201);
});

test('incidencias: tipo inválido se rechaza incluso para admin', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const response = await incidenciasHandler(fakeContext({ body: { tipo: 'algo_raro', motivo: 'x' }, roleIdentity: admin, db }));
  assert.equal(response.status, 400);
});

test('historial: un ejecutivo ajeno a la venta recibe 404, no la lista de eventos', async () => {
  const db = fakeDb();
  const otro = roleIdentity({ email: 'ejecutivo.b@example.com' });
  const response = await historialHandler(fakeContext({ method: 'GET', roleIdentity: otro, db }));
  assert.equal(response.status, 404);
});

test('historial: el dueño de la venta puede consultarlo', async () => {
  const db = fakeDb();
  const dueño = roleIdentity();
  const response = await historialHandler(fakeContext({ method: 'GET', roleIdentity: dueño, db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.data.eventos));
});

test('venta inexistente: cualquier ruta anidada devuelve 404, para cualquier rol', async () => {
  const db = fakeDb({ ventaExiste: false });
  const admin = roleIdentity({ role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const r1 = await componenteHandler(fakeContext({ body: { action: 'aprobar' }, roleIdentity: admin, db, params: { id: 'no-existe', componenteId: 'x' } }));
  assert.equal(r1.status, 404);
  const r2 = await historialHandler(fakeContext({ method: 'GET', roleIdentity: admin, db, params: { id: 'no-existe' } }));
  assert.equal(r2.status, 404);
});

test('método no permitido en las rutas de acción (GET en vez de POST) — 405', async () => {
  const db = fakeDb();
  const dueño = roleIdentity();
  const response = await componenteHandler(fakeContext({ method: 'GET', roleIdentity: dueño, db, params: { id: 'venta-1', componenteId: 'x' } }));
  assert.equal(response.status, 405);
});
