// Pruebas de functions/interno/api/identidad/* — RIO-111.
// Invoca los handlers y el middleware anidado directamente con un `context`
// fabricado (el JWT de Access ya se prueba aparte en access.test.js — acá
// se asume que el middleware padre ya corrió, igual que en health.test.js).
//
// Cubre en particular el requisito 7 de RIO-111: un ejecutivo no puede
// consultar los datos de otro ejecutivo modificando el parámetro `email` —
// ni la ruta ni el rol cambian, la única forma de escalar es tener admin
// real en D1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as whoamiHandler } from '../functions/interno/api/identidad/whoami.js';
import { onRequest as usuariosHandler } from '../functions/interno/api/identidad/usuarios.js';
import { onRequest as identidadMiddleware } from '../functions/interno/api/identidad/_middleware.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'ejecutivo.a@example.com',
    nombre: 'Ejecutivo A',
    role: 'ejecutivo',
    allowedMarkets: ['CL'],
    userStatus: 'activo',
    validFrom: '2026-01-01 00:00:00',
    validUntil: null,
    permissions: PERMISSIONS.ejecutivo,
    ...overrides,
  };
}

function fakeContext({ method = 'GET', url = 'https://rioimpulsodigital.com/interno/api/identidad/whoami', roleIdentity: ri, db } = {}) {
  return {
    request: new Request(url, { method }),
    env: { DB: db },
    data: { requestId: 'req-identidad-test', identity: { email: ri?.email || 'x@example.com' }, roleIdentity: ri },
  };
}

test('whoami sin parámetro — devuelve la identidad propia, ya resuelta por el middleware', async () => {
  const ri = roleIdentity();
  const response = await whoamiHandler(fakeContext({ roleIdentity: ri }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.email, 'ejecutivo.a@example.com');
  assert.equal(body.data.role, 'ejecutivo');
  assert.deepEqual(body.data.allowedMarkets, ['CL']);
});

test('whoami?email=<propio> — mismo resultado que sin parámetro (no es un intento de ver a otro)', async () => {
  const ri = roleIdentity();
  const response = await whoamiHandler(
    fakeContext({ roleIdentity: ri, url: 'https://rioimpulsodigital.com/interno/api/identidad/whoami?email=ejecutivo.a@example.com' })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.email, 'ejecutivo.a@example.com');
});

test('whoami?email=<otro> — un ejecutivo NUNCA recibe los datos de otra persona: 403, sin filtrar nada', async () => {
  const ri = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const response = await whoamiHandler(
    fakeContext({ roleIdentity: ri, url: 'https://rioimpulsodigital.com/interno/api/identidad/whoami?email=ejecutivo.b@example.com' })
  );
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'FORBIDDEN');
  assert.equal(body.data, null);
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /ejecutivo\.b/); // ni siquiera el email pedido se refleja de vuelta
});

test('whoami?email=<otro> — lo mismo para supervisor y asistente: tampoco pueden impersonar', async () => {
  for (const role of ['supervisor', 'asistente']) {
    const ri = roleIdentity({ email: 'yo@example.com', role, permissions: PERMISSIONS[role] });
    const response = await whoamiHandler(
      fakeContext({ roleIdentity: ri, url: 'https://rioimpulsodigital.com/interno/api/identidad/whoami?email=otra.persona@example.com' })
    );
    assert.equal(response.status, 403, `rol ${role} no debería poder ver a otro`);
  }
});

test('whoami?email=<otro> — un admin SÍ puede consultar la identidad de otra persona', async () => {
  const admin = roleIdentity({ email: 'brenda@rioimpulsodigital.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const db = {
    prepare(sql) {
      const params = [];
      return {
        bind(...p) { params.push(...p); return this; },
        first: async () => {
          if (sql.includes('FROM usuarios')) return { id: 99, email: 'ejecutivo.b@example.com', nombre: 'Ejecutivo B' };
          if (sql.includes('FROM asignaciones_rol')) {
            return { role: 'ejecutivo', allowed_markets: '["AR"]', user_status: 'activo', valid_from: '2026-01-01', valid_until: null };
          }
          throw new Error('consulta inesperada');
        },
      };
    },
  };
  const response = await whoamiHandler(
    fakeContext({ roleIdentity: admin, db, url: 'https://rioimpulsodigital.com/interno/api/identidad/whoami?email=ejecutivo.b@example.com' })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.email, 'ejecutivo.b@example.com');
  assert.deepEqual(body.data.allowedMarkets, ['AR']);
});

test('whoami?email=<inexistente> — admin consultando a alguien sin asignación vigente recibe 404, no un error interno', async () => {
  const admin = roleIdentity({ email: 'brenda@rioimpulsodigital.com', role: 'admin', permissions: PERMISSIONS.admin });
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        first: async () => null, // ni usuario ni asignación
      };
    },
  };
  const response = await whoamiHandler(
    fakeContext({ roleIdentity: admin, db, url: 'https://rioimpulsodigital.com/interno/api/identidad/whoami?email=nadie@example.com' })
  );
  assert.equal(response.status, 404);
});

test('método no permitido en whoami (POST) — 405', async () => {
  const response = await whoamiHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity() }));
  assert.equal(response.status, 405);
});

test('usuarios — admin obtiene el listado', async () => {
  const admin = roleIdentity({ role: 'admin', permissions: PERMISSIONS.admin });
  const db = {
    prepare() {
      return {
        bind() { return this; },
        all: async () => ({
          results: [
            { email: 'a@example.com', nombre: 'A', role: 'ejecutivo', allowed_markets: '["CL"]', user_status: 'activo', valid_from: '2026-01-01', valid_until: null },
          ],
        }),
      };
    },
  };
  const response = await usuariosHandler(fakeContext({ roleIdentity: admin, db, url: 'https://rioimpulsodigital.com/interno/api/identidad/usuarios' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.usuarios.length, 1);
  assert.equal(body.data.usuarios[0].role, 'ejecutivo');
});

test('usuarios — un ejecutivo, supervisor o asistente NO puede listar usuarios (403)', async () => {
  for (const role of ['ejecutivo', 'supervisor', 'asistente']) {
    const ri = roleIdentity({ role, permissions: PERMISSIONS[role] });
    const response = await usuariosHandler(fakeContext({ roleIdentity: ri, url: 'https://rioimpulsodigital.com/interno/api/identidad/usuarios' }));
    assert.equal(response.status, 403, `rol ${role} no debería poder listar usuarios`);
  }
});

test('middleware de /identidad — usuario no registrado en D1 queda bloqueado antes de llegar a la ruta', async () => {
  const db = {
    prepare() {
      return { bind() { return this; }, first: async () => null };
    },
  };
  let nextCalled = false;
  const context = {
    request: new Request('https://rioimpulsodigital.com/interno/api/identidad/whoami'),
    env: { DB: db },
    data: { requestId: 'req-mw-1', identity: { email: 'no.registrado@example.com' } },
    next: async () => { nextCalled = true; return new Response('no debería llegar acá'); },
  };
  const response = await identidadMiddleware(context);
  assert.equal(response.status, 403);
  assert.equal(nextCalled, false);
});

test('middleware de /identidad — usuario inactivo queda bloqueado antes de llegar a la ruta', async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        first: async () => {
          if (sql.includes('FROM usuarios')) return { id: 1, email: 'inactivo@example.com', nombre: 'Inactivo' };
          return { role: 'ejecutivo', allowed_markets: '["CL"]', user_status: 'inactivo', valid_from: '2026-01-01', valid_until: null };
        },
      };
    },
  };
  let nextCalled = false;
  const context = {
    request: new Request('https://rioimpulsodigital.com/interno/api/identidad/whoami'),
    env: { DB: db },
    data: { requestId: 'req-mw-2', identity: { email: 'inactivo@example.com' } },
    next: async () => { nextCalled = true; return new Response('no debería llegar acá'); },
  };
  const response = await identidadMiddleware(context);
  assert.equal(response.status, 403);
  assert.equal(nextCalled, false);
});

test('middleware de /identidad — usuario activo con asignación vigente sí llega a la ruta, con roleIdentity resuelta', async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        first: async () => {
          if (sql.includes('FROM usuarios')) return { id: 1, email: 'activo@example.com', nombre: 'Activo' };
          return { role: 'ejecutivo', allowed_markets: '["CL"]', user_status: 'activo', valid_from: '2026-01-01', valid_until: null };
        },
      };
    },
  };
  let receivedRoleIdentity = null;
  const context = {
    request: new Request('https://rioimpulsodigital.com/interno/api/identidad/whoami'),
    env: { DB: db },
    data: { requestId: 'req-mw-3', identity: { email: 'activo@example.com' } },
    next: async () => {
      receivedRoleIdentity = context.data.roleIdentity;
      return new Response('ok');
    },
  };
  const response = await identidadMiddleware(context);
  assert.equal(response.status, 200);
  assert.equal(receivedRoleIdentity.role, 'ejecutivo');
  assert.equal(receivedRoleIdentity.email, 'activo@example.com');
});
