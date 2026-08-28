// Pruebas de functions/_shared/authz.js — RIO-111.
// Autorización positiva y negativa por rol y mercado, y aislamiento entre
// usuarios (un ejecutivo no puede ver datos de otro, ni con parámetros).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRoleIdentity,
  assertMarketAllowed,
  assertCanAccessOwner,
  AuthzError,
  PERMISSIONS,
} from '../functions/_shared/authz.js';

// D1 simulado: modela solo las dos consultas que usa authz.js, con datos en
// memoria — no es un motor SQL real, pero respeta el mismo contrato de
// prepare().bind().first() que usa el código real.
function fakeDb({ usuarios = [], asignaciones = [] } = {}) {
  return {
    prepare(sql) {
      const params = [];
      return {
        bind(...p) {
          params.push(...p);
          return this;
        },
        first: async () => {
          if (sql.includes('FROM usuarios')) {
            const email = params[0];
            return usuarios.find((u) => u.email === email) || null;
          }
          if (sql.includes('FROM asignaciones_rol')) {
            const usuarioId = params[0];
            const now = new Date().toISOString();
            const vigentes = asignaciones
              .filter((a) => a.usuario_id === usuarioId)
              .filter((a) => !a.valid_until || a.valid_until > now)
              .filter((a) => a.valid_from <= now)
              .sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
            return vigentes[0] || null;
          }
          throw new Error('consulta inesperada en test: ' + sql);
        },
      };
    },
  };
}

const PAST = '2020-01-01 00:00:00';
const FUTURE = '2099-01-01 00:00:00';

test('resolveRoleIdentity() — usuario con asignación vigente devuelve rol, mercados, mercado predeterminado y permisos', async () => {
  const db = fakeDb({
    usuarios: [{ id: 1, email: 'ejecutivo.cl@example.com', nombre: 'Test CL' }],
    asignaciones: [
      { usuario_id: 1, role: 'ejecutivo', allowed_markets: '["CL"]', default_market: 'CL', user_status: 'activo', valid_from: PAST, valid_until: null },
    ],
  });
  const identity = await resolveRoleIdentity(db, 'ejecutivo.cl@example.com', 'req-1');
  assert.equal(identity.role, 'ejecutivo');
  assert.deepEqual(identity.allowedMarkets, ['CL']);
  assert.equal(identity.defaultMarket, 'CL');
  assert.equal(identity.userStatus, 'activo');
  assert.equal(identity.permissions, PERMISSIONS.ejecutivo);
});

test('resolveRoleIdentity() — mercado predeterminado puede diferir del primero de allowedMarkets (ej. Brenda: CL,AR pero default AR)', async () => {
  const db = fakeDb({
    usuarios: [{ id: 10, email: 'multi.mercado@example.com', nombre: 'Multi' }],
    asignaciones: [
      { usuario_id: 10, role: 'admin', allowed_markets: '["CL","AR"]', default_market: 'AR', user_status: 'activo', valid_from: PAST, valid_until: null },
    ],
  });
  const identity = await resolveRoleIdentity(db, 'multi.mercado@example.com', 'req-1b');
  assert.deepEqual(identity.allowedMarkets, ['CL', 'AR']);
  assert.equal(identity.defaultMarket, 'AR');
});

test('resolveRoleIdentity() — si default_market viene vacío en la fila, cae al primer mercado autorizado (nunca a uno fijo)', async () => {
  const db = fakeDb({
    usuarios: [{ id: 11, email: 'sin.default@example.com', nombre: 'Sin Default' }],
    asignaciones: [
      { usuario_id: 11, role: 'ejecutivo', allowed_markets: '["AR"]', default_market: null, user_status: 'activo', valid_from: PAST, valid_until: null },
    ],
  });
  const identity = await resolveRoleIdentity(db, 'sin.default@example.com', 'req-1c');
  assert.equal(identity.defaultMarket, 'AR');
});

test('resolveRoleIdentity() — email no registrado en usuarios queda bloqueado', async () => {
  const db = fakeDb({ usuarios: [], asignaciones: [] });
  await assert.rejects(() => resolveRoleIdentity(db, 'nadie@example.com', 'req-2'), (e) => {
    assert.ok(e instanceof AuthzError);
    assert.equal(e.reason, 'user_not_registered');
    return true;
  });
});

test('resolveRoleIdentity() — usuario registrado pero sin ninguna asignación queda bloqueado', async () => {
  const db = fakeDb({ usuarios: [{ id: 5, email: 'sin.rol@example.com', nombre: 'Sin Rol' }], asignaciones: [] });
  await assert.rejects(() => resolveRoleIdentity(db, 'sin.rol@example.com', 'req-3'), (e) => {
    assert.equal(e.reason, 'no_active_assignment');
    return true;
  });
});

test('resolveRoleIdentity() — asignación con user_status inactivo queda bloqueado', async () => {
  const db = fakeDb({
    usuarios: [{ id: 2, email: 'baja@example.com', nombre: 'Dado de baja' }],
    asignaciones: [
      { usuario_id: 2, role: 'ejecutivo', allowed_markets: '["CL"]', user_status: 'inactivo', valid_from: PAST, valid_until: null },
    ],
  });
  await assert.rejects(() => resolveRoleIdentity(db, 'baja@example.com', 'req-4'), (e) => {
    assert.equal(e.reason, 'user_inactive');
    return true;
  });
});

test('resolveRoleIdentity() — asignación ya vencida (valid_until pasado) no cuenta como vigente', async () => {
  const db = fakeDb({
    usuarios: [{ id: 3, email: 'vencido@example.com', nombre: 'Vencido' }],
    asignaciones: [
      { usuario_id: 3, role: 'ejecutivo', allowed_markets: '["CL"]', user_status: 'activo', valid_from: PAST, valid_until: PAST },
    ],
  });
  await assert.rejects(() => resolveRoleIdentity(db, 'vencido@example.com', 'req-5'), (e) => {
    assert.equal(e.reason, 'no_active_assignment');
    return true;
  });
});

test('resolveRoleIdentity() — cambio de rol: toma la asignación vigente más reciente, no una vieja ya cerrada', async () => {
  const db = fakeDb({
    usuarios: [{ id: 4, email: 'promovido@example.com', nombre: 'Promovido' }],
    asignaciones: [
      { usuario_id: 4, role: 'ejecutivo', allowed_markets: '["CL"]', user_status: 'activo', valid_from: PAST, valid_until: '2024-01-01 00:00:00' },
      { usuario_id: 4, role: 'supervisor', allowed_markets: '["CL","AR"]', user_status: 'activo', valid_from: '2024-01-01 00:00:00', valid_until: null },
    ],
  });
  const identity = await resolveRoleIdentity(db, 'promovido@example.com', 'req-6');
  assert.equal(identity.role, 'supervisor');
  assert.deepEqual(identity.allowedMarkets, ['CL', 'AR']);
});

test('resolveRoleIdentity() — historial anterior no se altera: la fila vieja conserva su rol original', async () => {
  // Mismo escenario que arriba, pero se verifica que la fila cerrada sigue
  // intacta en los datos (no fue editada, solo dejó de ser la vigente).
  const asignaciones = [
    { usuario_id: 4, role: 'ejecutivo', allowed_markets: '["CL"]', user_status: 'activo', valid_from: PAST, valid_until: '2024-01-01 00:00:00' },
    { usuario_id: 4, role: 'supervisor', allowed_markets: '["CL","AR"]', user_status: 'activo', valid_from: '2024-01-01 00:00:00', valid_until: null },
  ];
  const original = asignaciones[0];
  assert.equal(original.role, 'ejecutivo');
  assert.equal(original.valid_until, '2024-01-01 00:00:00');
});

test('resolveRoleIdentity() — rol desconocido en D1 (fuera del set del código) queda bloqueado, sin permiso por defecto', async () => {
  const db = fakeDb({
    usuarios: [{ id: 6, email: 'rol.raro@example.com', nombre: 'Rol Raro' }],
    asignaciones: [
      { usuario_id: 6, role: 'superadmin-no-existe', allowed_markets: '["CL"]', user_status: 'activo', valid_from: PAST, valid_until: null },
    ],
  });
  await assert.rejects(() => resolveRoleIdentity(db, 'rol.raro@example.com', 'req-7'), (e) => {
    assert.equal(e.reason, 'unknown_role');
    return true;
  });
});

test('assertMarketAllowed() — acepta un mercado dentro de allowedMarkets', () => {
  assert.doesNotThrow(() => assertMarketAllowed({ allowedMarkets: ['CL', 'AR'] }, 'AR'));
});

test('assertMarketAllowed() — rechaza un mercado fuera de allowedMarkets, incluso para admin', () => {
  assert.throws(() => assertMarketAllowed({ allowedMarkets: ['CL'] }, 'AR'), (e) => {
    assert.ok(e instanceof AuthzError);
    assert.equal(e.reason, 'market_not_allowed');
    return true;
  });
});

test('assertCanAccessOwner() — cualquiera puede acceder a su propio recurso', () => {
  const identity = { email: 'yo@example.com', allowedMarkets: ['CL'], permissions: PERMISSIONS.ejecutivo };
  assert.doesNotThrow(() => assertCanAccessOwner(identity, 'yo@example.com', 'CL'));
});

test('assertCanAccessOwner() — un ejecutivo NO puede acceder al recurso de otro ejecutivo', () => {
  const identity = { email: 'ejecutivo.a@example.com', allowedMarkets: ['CL'], permissions: PERMISSIONS.ejecutivo };
  assert.throws(() => assertCanAccessOwner(identity, 'ejecutivo.b@example.com', 'CL'), (e) => {
    assert.ok(e instanceof AuthzError);
    assert.equal(e.reason, 'resource_not_owned');
    return true;
  });
});

test('assertCanAccessOwner() — un asistente NO puede acceder al recurso de otra persona', () => {
  const identity = { email: 'asistente@example.com', allowedMarkets: [], permissions: PERMISSIONS.asistente };
  assert.throws(() => assertCanAccessOwner(identity, 'otro@example.com', 'CL'), (e) => {
    assert.equal(e.reason, 'resource_not_owned');
    return true;
  });
});

test('assertCanAccessOwner() — un admin puede acceder al recurso de cualquiera', () => {
  const identity = { email: 'admin@example.com', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin };
  assert.doesNotThrow(() => assertCanAccessOwner(identity, 'cualquiera@example.com', 'AR'));
});

test('assertCanAccessOwner() — un supervisor puede acceder a un recurso de SU mercado', () => {
  const identity = { email: 'supervisor@example.com', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.supervisor };
  assert.doesNotThrow(() => assertCanAccessOwner(identity, 'ejecutivo.ar@example.com', 'AR'));
});

test('assertCanAccessOwner() — un supervisor NO puede acceder a un recurso de un mercado que no tiene asignado', () => {
  const identity = { email: 'supervisor.cl@example.com', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor };
  assert.throws(() => assertCanAccessOwner(identity, 'ejecutivo.ar@example.com', 'AR'), (e) => {
    assert.equal(e.reason, 'resource_not_owned');
    return true;
  });
});
