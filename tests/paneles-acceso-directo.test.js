// Confirma el punto obligatorio de RIO-123 "Acceso directo": abrir la URL de
// un panel no autorizado no alcanza para operar con sus APIs. Mostrar/ocultar
// una tarjeta en interno/index.html es SOLO presentación (tests/paneles-autorizados.test.js) —
// la protección real ya vive, desde antes de esta tarea, en cada endpoint:
// vuelve a exigir su propio permiso en el servidor, sin importar qué haya
// hecho el navegador. Esta suite no agrega ninguna regla nueva: verifica que
// la que ya existe efectivamente rechaza a quien no tiene el panel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as comisionesHandler } from '../functions/interno/api/comisiones/index.js';
import { onRequest as personasHandler } from '../functions/interno/api/personas/index.js';
import { onRequest as equiposHandler } from '../functions/interno/api/equipos/index.js';
import { PERMISSIONS, panelesAutorizados } from '../functions/_shared/authz.js';

function identidad(role, overrides = {}) {
  return { email: `${role}@example.com`, role, allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS[role], ...overrides };
}
function ctx(roleIdentity, { url, method = 'GET', db } = {}) {
  return { request: new Request(url || 'https://rioimpulsodigital.com/interno/api/x', { method }), env: { DB: db || fakeDbVacia() }, params: {}, data: { requestId: 'req-acceso-directo', identity: { email: roleIdentity.email }, roleIdentity } };
}

// Solo hace falta que el permiso se evalúe: estas 2 rutas consultan D1 recién
// después de la compuerta de permiso, así que una base vacía basta para
// probar que el 403 (o su ausencia) viene del permiso, no de un dato real.
function fakeDbVacia() {
  return { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [] }), first: async () => null }) };
}

test('un ejecutivo (solo Panel Vendedor autorizado) recibe 403 de GET /comisiones?estado=programada — endpoint exclusivo de Panel Administrativo', async () => {
  const ri = identidad('ejecutivo');
  assert.deepEqual(panelesAutorizados(ri), ['vendedor'], 'no tiene el panel administrativo');
  const r = await comisionesHandler(ctx(ri, { url: 'https://rioimpulsodigital.com/interno/api/comisiones?estado=programada' }));
  assert.equal(r.status, 403, 'abrir /interno/panel-administrativo.html a mano no otorga el permiso que la API sigue exigiendo');
});

test('un supervisor (Vendedor + Supervisor, sin Administrativo) recibe 403 de POST /personas — alta de personas es exclusiva de Administrativo', async () => {
  const ri = identidad('supervisor');
  assert.deepEqual(panelesAutorizados(ri), ['vendedor', 'supervisor']);
  const r = await personasHandler(ctx(ri, { method: 'POST' }));
  assert.equal(r.status, 403);
});

test('un supervisor recibe 403 de GET /equipos — la lectura completa de equipos exige viewOthersData===true (solo admin), no alcanza con "sameMarketOnly"', async () => {
  const ri = identidad('supervisor');
  const r = await equiposHandler(ctx(ri));
  assert.equal(r.status, 403);
});

test('solo quien tiene el panel Administrativo (rol admin) pasa el permiso real de estas 3 rutas', async () => {
  const ri = identidad('admin', { allowedMarkets: ['CL', 'AR'] });
  assert.deepEqual(panelesAutorizados(ri), ['vendedor', 'supervisor', 'administrativo']);
  assert.notEqual((await comisionesHandler(ctx(ri, { url: 'https://rioimpulsodigital.com/interno/api/comisiones?estado=programada' }))).status, 403);
  assert.notEqual((await equiposHandler(ctx(ri))).status, 403);
});
