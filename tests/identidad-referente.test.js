// Pruebas de GET /interno/api/identidad/referente — RIO-118 (corrección,
// decisiones de Brenda sobre identidad visible, equipos y referente
// comercial, 01/09/2026). "Mi referente comercial" del Panel del
// Vendedor: siempre resuelto sobre la sesión ya autenticada, nunca sobre
// un parámetro del cliente — no hay ningún id que manipular.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as referenteHandler } from '../functions/interno/api/identidad/referente.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return { email: 'gabriela@example.com', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}

function fakeDb() {
  const state = {
    equipo_miembros: [],
    equipo_supervisores: [],
    equipos: [
      { id: 'equipo-cl-1', nombre: 'Equipo Alberto — Chile', mercado: 'CL' },
      { id: 'equipo-ar-1', nombre: 'Equipo Alberto — Argentina', mercado: 'AR' },
    ],
    usuarios: [
      { id: 1, email: 'alberto@example.com', nombre: 'Alberto Pérez', whatsapp_laboral: null },
      { id: 2, email: 'gabriela@example.com', nombre: 'Gabriela Alero', whatsapp_laboral: null },
    ],
  };

  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => ({ success: true }),
    };
  }

  function vigente(row) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    return (!row.valid_until || row.valid_until > now) && (!row.valid_from || row.valid_from <= now);
  }

  function runSelect(sql, p) {
    if (sql.includes('FROM equipo_miembros em JOIN equipos e')) {
      return state.equipo_miembros
        .filter((m) => m.usuario_email === p[0] && vigente(m))
        .map((m) => {
          const eq = state.equipos.find((e) => e.id === m.equipo_id);
          return { equipo_id: m.equipo_id, equipo_nombre: eq?.nombre, mercado: eq?.mercado };
        });
    }
    if (sql.includes('FROM equipo_supervisores es LEFT JOIN usuarios u')) {
      const filas = state.equipo_supervisores
        .filter((s) => s.equipo_id === p[0] && s.es_principal && vigente(s))
        .sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
      const s = filas[0];
      if (!s) return [];
      const u = state.usuarios.find((x) => x.email === s.usuario_email);
      return [{ usuario_email: s.usuario_email, usuario_id: u?.id, nombre: u?.nombre, whatsapp_laboral: u?.whatsapp_laboral }];
    }
    return [];
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'GET', url = 'https://rioimpulsodigital.com/interno/api/identidad/referente', roleIdentity: ri, db } = {}) {
  return {
    request: new Request(url, { method }),
    env: { DB: db },
    data: { requestId: 'req-referente-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

test('referente: un vendedor de un solo equipo, con supervisor sin WhatsApp configurado, recibe el nombre y el estado "pendiente" — nunca un enlace roto', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'gabriela@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: null });

  const r = await referenteHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.data.referentes.length, 1);
  const ref = body.data.referentes[0];
  assert.equal(ref.supervisorNombre, 'Alberto Pérez');
  assert.equal(ref.equipoNombre, 'Equipo Alberto — Chile');
  assert.equal(ref.mercado, 'CL');
  assert.equal(ref.whatsappLaboral, null);
  assert.equal(ref.disponibilidad, 'pendiente');
  assert.equal(ref.esUnoMismo, false);
});

test('referente: con WhatsApp laboral configurado, devuelve el número normalizado y disponibilidad "configurado"', async () => {
  const db = fakeDb();
  db._state.usuarios.find((u) => u.email === 'alberto@example.com').whatsapp_laboral = '56911112222';
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'gabriela@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: null });

  const r = await referenteHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  const body = await r.json();
  assert.equal(body.data.referentes[0].whatsappLaboral, '56911112222');
  assert.equal(body.data.referentes[0].disponibilidad, 'configurado');
});

test('referente: un equipo sin ningún supervisor vigente devuelve "sin_supervisor" — nunca inventa un contacto', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'gabriela@example.com', valid_until: null });
  // sin equipo_supervisores para equipo-cl-1.
  const r = await referenteHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  const body = await r.json();
  assert.equal(body.data.referentes[0].disponibilidad, 'sin_supervisor');
  assert.equal(body.data.referentes[0].supervisorNombre, null);
});

test('referente: un supervisor que vende dentro de su propio equipo no recibe un enlace para escribirse a sí mismo', async () => {
  const db = fakeDb();
  db._state.usuarios.find((u) => u.email === 'alberto@example.com').whatsapp_laboral = '56911112222';
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: null });

  const alberto = roleIdentity({ email: 'alberto@example.com', role: 'supervisor', permissions: PERMISSIONS.supervisor });
  const r = await referenteHandler(fakeContext({ roleIdentity: alberto, db }));
  const body = await r.json();
  assert.equal(body.data.referentes[0].esUnoMismo, true);
  assert.equal(body.data.referentes[0].whatsappLaboral, null, 'nunca se devuelve un número para escribirse a uno mismo, aunque esté configurado');
  assert.equal(body.data.referentes[0].disponibilidad, 'uno_mismo');
});

test('referente: un vendedor en VARIOS equipos vigentes recibe un referente por cada uno', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'gabriela@example.com', valid_until: null });
  db._state.equipo_miembros.push({ equipo_id: 'equipo-ar-1', usuario_email: 'gabriela@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-ar-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: null });

  const r = await referenteHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  const body = await r.json();
  assert.equal(body.data.referentes.length, 2);
  assert.deepEqual(body.data.referentes.map((x) => x.mercado).sort(), ['AR', 'CL']);
});

test('referente: una asignación de equipo VENCIDA no concede acceso — no aparece entre los referentes', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'gabriela@example.com', valid_until: '2020-01-01 00:00:00' });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: null });

  const r = await referenteHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  const body = await r.json();
  assert.equal(body.data.referentes.length, 0);
});

test('referente: cambiar de supervisor (cerrar el anterior, abrir uno nuevo) conserva el historial — el endpoint refleja al vigente, nunca borra la fila anterior', async () => {
  const db = fakeDb();
  db._state.usuarios.push({ id: 3, email: 'nuevo.supervisor@example.com', nombre: 'Camila Ruiz', whatsapp_laboral: '56933334444' });
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'gabriela@example.com', valid_until: null });
  // Supervisor anterior — cerrado (valid_until en el pasado), nunca borrado.
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: '2026-08-01 00:00:00' });
  // Supervisor nuevo — vigente.
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'nuevo.supervisor@example.com', es_principal: 1, valid_until: null });

  const r = await referenteHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  const body = await r.json();
  assert.equal(body.data.referentes[0].supervisorNombre, 'Camila Ruiz');
  assert.equal(db._state.equipo_supervisores.length, 2, 'la fila del supervisor anterior sigue existiendo, nunca se borra');
});

test('referente: nunca acepta parámetros del cliente — un query string con otro email/equipo no cambia la respuesta (siempre resuelve sobre la sesión)', async () => {
  const db = fakeDb();
  db._state.equipo_miembros.push({ equipo_id: 'equipo-cl-1', usuario_email: 'gabriela@example.com', valid_until: null });
  db._state.equipo_supervisores.push({ equipo_id: 'equipo-cl-1', usuario_email: 'alberto@example.com', es_principal: 1, valid_until: null });

  const url = 'https://rioimpulsodigital.com/interno/api/identidad/referente?email=otro@example.com&equipoId=equipo-ar-1&usuarioId=999';
  const r = await referenteHandler(fakeContext({ url, roleIdentity: roleIdentity(), db }));
  const body = await r.json();
  assert.equal(body.data.referentes.length, 1);
  assert.equal(body.data.referentes[0].equipoId, 'equipo-cl-1', 'ignora por completo cualquier parámetro del cliente');
});

test('referente: sin ningún equipo vigente, devuelve una lista vacía (nunca un error)', async () => {
  const db = fakeDb();
  const r = await referenteHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.data.referentes, []);
});

test('método no permitido en /identidad/referente (POST) — 405', async () => {
  const db = fakeDb();
  const r = await referenteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db }));
  assert.equal(r.status, 405);
});
