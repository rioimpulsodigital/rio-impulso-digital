// Pruebas de "Mis paneles" — RIO-123 (27/09/2026).
//
// Qué paneles puede usar cada identidad lo decide el SERVIDOR, desde la misma
// autorización vigente (roleIdentity ← D1): `panelesAutorizados()` en
// functions/_shared/authz.js, entregado por whoami. interno/index.html solo
// dibuja las tarjetas. Ocultar una tarjeta NO es autorización: la protección
// real de cada API está en tests/paneles-acceso-directo.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest as whoamiHandler } from '../functions/interno/api/identidad/whoami.js';
import { PERMISSIONS, panelesAutorizados, requireRoleIdentity } from '../functions/_shared/authz.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function identidad(role, overrides = {}) {
  return {
    email: `${role}@example.com`, nombre: role, role, allowedMarkets: ['CL'], defaultMarket: 'CL',
    canSell: role !== 'asistente', userStatus: 'activo', validFrom: '2026-01-01', validUntil: null,
    permissions: PERMISSIONS[role], ...overrides,
  };
}

function fakeContext(roleIdentity, { url = 'https://rioimpulsodigital.com/interno/api/identidad/whoami', db } = {}) {
  return {
    request: new Request(url),
    env: { DB: db },
    data: { requestId: 'req-paneles-test', identity: { email: roleIdentity.email }, roleIdentity },
  };
}

// ── Matriz efectiva ─────────────────────────────────────────────────────

test('matriz efectiva — ejecutivo: solo Panel Vendedor', () => {
  assert.deepEqual(panelesAutorizados(identidad('ejecutivo')), ['vendedor']);
});

test('matriz efectiva — asistente: solo Panel Vendedor (también ve sus comisiones propias, RIO-122)', () => {
  assert.deepEqual(panelesAutorizados(identidad('asistente')), ['vendedor']);
});

test('matriz efectiva — supervisor: Vendedor y Supervisor, nunca Administrativo', () => {
  assert.deepEqual(panelesAutorizados(identidad('supervisor')), ['vendedor', 'supervisor']);
});

test('matriz efectiva — administración: Vendedor, Supervisor y Administrativo (multirrol: recibe todas sus autorizaciones)', () => {
  assert.deepEqual(panelesAutorizados(identidad('admin')), ['vendedor', 'supervisor', 'administrativo']);
});

test('sin rol / sin autorización resuelta: ningún panel', () => {
  assert.deepEqual(panelesAutorizados(null), []);
  assert.deepEqual(panelesAutorizados(undefined), []);
  assert.deepEqual(panelesAutorizados({}), []);
  assert.deepEqual(panelesAutorizados({ email: 'x@example.com' }), []);
  assert.deepEqual(panelesAutorizados({ role: 'ejecutivo' }), [], 'sin permisos resueltos no se asume ninguno');
});

test('la autorización sale de las capacidades reales, no del nombre: una capacidad viewOthersData habilita Supervisor, su ausencia lo quita', () => {
  const sinCapacidad = identidad('supervisor', { permissions: { ...PERMISSIONS.supervisor, viewOthersData: false } });
  assert.deepEqual(panelesAutorizados(sinCapacidad), ['vendedor']);
  const conCapacidad = identidad('ejecutivo', { permissions: { ...PERMISSIONS.ejecutivo, viewOthersData: 'sameMarketOnly' } });
  assert.deepEqual(panelesAutorizados(conCapacidad), ['vendedor', 'supervisor']);
});

// ── whoami ──────────────────────────────────────────────────────────────

test('whoami entrega panelesAutorizados derivados en el servidor, sin exponer nada más que ids de panel', async () => {
  for (const role of ['ejecutivo', 'asistente', 'supervisor', 'admin']) {
    const ri = identidad(role);
    const response = await whoamiHandler(fakeContext(ri));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.panelesAutorizados, panelesAutorizados(ri), `whoami de ${role}`);
    assert.ok(body.data.panelesAutorizados.every((p) => typeof p === 'string'));
  }
});

test('whoami — un ejecutivo NO recibe paneles que no posee, aunque los pida cambiando parámetros', async () => {
  const ri = identidad('ejecutivo');
  const response = await whoamiHandler(fakeContext(ri, { url: 'https://rioimpulsodigital.com/interno/api/identidad/whoami?email=admin@example.com&paneles=administrativo' }));
  assert.equal(response.status, 403, 'pedir la identidad de otra persona sigue siendo 403 para no-admin');
});

function fakeDbUsuarios({ usuario = null, asignacion = null } = {}) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        first: async () => (sql.includes('FROM usuarios') ? usuario : asignacion),
      };
    },
  };
}

test('usuario autenticado por Access pero NO registrado en D1: el middleware lo bloquea y no hay ninguna respuesta de paneles', async () => {
  const context = { env: { DB: fakeDbUsuarios({ usuario: null }) }, data: { requestId: 'r', identity: { email: 'desconocido@example.com' } }, next: async () => new Response('no debe llegar') };
  const response = await requireRoleIdentity(context);
  assert.equal(response.status, 403);
  const texto = await response.text();
  assert.ok(!texto.includes('panelesAutorizados'));
  assert.ok(!texto.includes('no debe llegar'));
});

test('usuario registrado pero SIN asignación de rol vigente: bloqueado, sin paneles', async () => {
  const context = { env: { DB: fakeDbUsuarios({ usuario: { id: 1, email: 'x@example.com', nombre: 'X' }, asignacion: null }) }, data: { requestId: 'r', identity: { email: 'x@example.com' } }, next: async () => new Response('no debe llegar') };
  const response = await requireRoleIdentity(context);
  assert.equal(response.status, 403);
});

test('whoami?email= (admin): las autorizaciones de la OTRA persona se derivan de SU asignación en D1', async () => {
  const admin = identidad('admin');
  const db = fakeDbUsuarios({
    usuario: { id: 7, email: 'otra@example.com', nombre: 'Otra' },
    asignacion: { role: 'supervisor', allowed_markets: '["CL"]', default_market: 'CL', can_sell: 1, can_receive_commission_advance: 0, user_status: 'activo', valid_from: '2026-01-01', valid_until: null },
  });
  const response = await whoamiHandler(fakeContext(admin, { url: 'https://rioimpulsodigital.com/interno/api/identidad/whoami?email=otra@example.com', db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.role, 'supervisor');
  assert.deepEqual(body.data.panelesAutorizados, ['vendedor', 'supervisor']);
});

// ── Sin hardcode, sin ramas por entorno ─────────────────────────────────

function bloque(texto, inicio, fin) {
  const i = texto.indexOf(inicio);
  const j = texto.indexOf(fin);
  assert.ok(i >= 0 && j > i, `marcadores ${inicio}/${fin} presentes`);
  return texto.slice(i, j);
}
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

test('ninguna autorización de paneles depende de un correo, un nombre ni una lista local (servidor y navegador)', () => {
  const servidor = bloque(leer('functions/_shared/authz.js'), 'PANELES:INICIO', 'PANELES:FIN');
  const navegador = bloque(leer('interno/index.html'), 'MIS-PANELES:INICIO', 'MIS-PANELES:FIN');
  const whoami = leer('functions/interno/api/identidad/whoami.js');
  for (const [nombre, codigo] of [['authz.js (PANELES)', servidor], ['index.html (MIS-PANELES)', navegador], ['whoami.js', whoami]]) {
    assert.ok(!EMAIL.test(codigo), `${nombre} no contiene ningún correo`);
    assert.ok(!/\.email\s*[!=]==?/.test(codigo), `${nombre} no compara correos`);
    assert.ok(!/\b(brenda|alberto|gabriela|julia|lorena|fuad|nina|maira|christian)\b/i.test(codigo.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), `${nombre} no menciona personas en el código`);
  }
  assert.ok(!/USER_MAP|allowedEmails|EMAILS_/i.test(navegador), 'sin listas locales de usuarios');
});

test('Preview y Producción usan exactamente el mismo modelo de autorización: la regla no ramifica por entorno ni por dominio', () => {
  const codigo = bloque(leer('functions/_shared/authz.js'), 'PANELES:INICIO', 'PANELES:FIN').replace(/\/\/.*$/gm, '');
  assert.ok(!/preview|production|producci[oó]n|pages\.dev|hostname|location|env\b/i.test(codigo), 'sin referencias a entorno ni dominio en la regla');
  assert.equal(panelesAutorizados.length, 1, 'la regla depende solo de la identidad resuelta');
  const navegador = bloque(leer('interno/index.html'), 'MIS-PANELES:INICIO', 'MIS-PANELES:FIN').replace(/\/\/.*$/gm, '');
  assert.ok(!/pages\.dev|hostname|location\./i.test(navegador), 'el navegador tampoco decide por dominio');
});

// ── Coherencia con los guards REALES de cada panel ───────────────────────

// Extrae la condición de bloqueo que cada panel evalúa justo después de
// `identity = await whoami();` y la evalúa contra cada rol: si alguien cambia
// el guard de un panel sin actualizar PANELES (o al revés), esta prueba falla.
function condicionDeBloqueo(archivo) {
  const src = leer(archivo);
  const desde = src.indexOf('identity = await whoami();');
  assert.ok(desde >= 0, `${archivo}: guard de whoami encontrado`);
  const m = src.slice(desde).match(/if \((.+)\) \{\s*document\.getElementById\('pvBlocked'\)\.style\.display = 'block';/);
  assert.ok(m, `${archivo}: condición de bloqueo encontrada`);
  return new Function('identity', `return !!(${m[1]});`);
}

test('coherencia — la regla del servidor coincide, rol por rol, con el guard real de cada panel', () => {
  const guards = {
    vendedor: condicionDeBloqueo('interno/panel-vendedor.js'),
    supervisor: condicionDeBloqueo('interno/panel-supervisor.js'),
    administrativo: condicionDeBloqueo('interno/panel-administrativo.js'),
  };
  for (const role of ['ejecutivo', 'asistente', 'supervisor', 'admin']) {
    const ri = identidad(role);
    const enWhoami = { ...ri, nombre: ri.nombre }; // lo que el panel recibe de whoami
    const permitidos = panelesAutorizados(ri);
    for (const panel of Object.keys(guards)) {
      const bloqueado = guards[panel](enWhoami);
      assert.equal(!bloqueado, permitidos.includes(panel), `${role} / ${panel}: el guard del panel y panelesAutorizados() deben coincidir`);
    }
  }
  assert.equal(guards.vendedor(null), true, 'sin identidad resuelta el guard bloquea');
});
