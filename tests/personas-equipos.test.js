// Pruebas de functions/interno/api/personas/* y functions/interno/api/
// equipos/* — RIO-119 (segundo bloque, administración de personas y
// equipos, 02/09/2026). Cubre: creación de perfiles, edición no
// versionada del perfil (siempre auditada), cambio de asignación de rol
// (SIEMPRE versionado — nunca sobrescribe), creación/activación de
// equipos, y alta/baja/marcado-principal de miembros y supervisores
// (versionado, nunca borra una fila).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as personasHandler } from '../functions/interno/api/personas/index.js';
import { onRequest as personaEmailHandler } from '../functions/interno/api/personas/[email]/index.js';
import { onRequest as equiposHandler } from '../functions/interno/api/equipos/index.js';
import { onRequest as equipoIdHandler } from '../functions/interno/api/equipos/[id]/index.js';
import { onRequest as miembrosHandler } from '../functions/interno/api/equipos/[id]/miembros/index.js';
import { onRequest as supervisoresHandler } from '../functions/interno/api/equipos/[id]/supervisores/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'admin@example.com',
    nombre: 'Admin',
    role: 'admin',
    allowedMarkets: ['CL', 'AR'],
    defaultMarket: 'CL',
    userStatus: 'activo',
    canSell: true,
    permissions: PERMISSIONS.admin,
    ...overrides,
  };
}

function fakeDb() {
  const state = {
    usuarios: [], asignaciones_rol: [], equipos: [], equipo_miembros: [], equipo_supervisores: [], eventos_historial: [],
  };
  let nextUsuarioId = 1;
  let nextAsignacionId = 1;

  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => { runMutation(sql, p); return { success: true }; },
    };
  }

  function vigente(rows) {
    return rows.filter((r) => !r.valid_until);
  }

  function runMutation(sql, p) {
    // OJO: 'usuarios_correos_historicos' arranca con la substring
    // "usuarios" — este chequeo va PRIMERO para no caer por accidente en
    // la rama genérica de abajo (startsWith no respeta límites de palabra).
    if (sql.startsWith('INSERT INTO usuarios_correos_historicos')) {
      state.usuarios_correos_historicos = state.usuarios_correos_historicos || [];
      state.usuarios_correos_historicos.push({ id: p[0], usuario_id: p[1], correo_anterior: p[2], correo_nuevo: p[3], changed_by: p[4] });
    } else if (sql.startsWith('UPDATE usuarios SET email')) {
      const u = state.usuarios.find((x) => x.id === p[1]);
      if (u) u.email = p[0];
    } else if (sql.startsWith('INSERT INTO usuarios')) {
      state.usuarios.push({
        id: nextUsuarioId++, email: p[0], nombre: p[1], documento_identidad: p[2] || null,
        telefono: p[3] || null, whatsapp_laboral: p[4] || null, acceso_estado: 'perfil_creado', created_at: '2026-09-02 00:00:00',
      });
    } else if (sql.startsWith('UPDATE usuarios SET nombre')) {
      const u = state.usuarios.find((x) => x.id === p[5]);
      if (u) Object.assign(u, { nombre: p[0], documento_identidad: p[1], telefono: p[2], whatsapp_laboral: p[3], acceso_estado: p[4] });
    } else if (sql.startsWith('INSERT INTO asignaciones_rol') && sql.includes('note')) {
      state.asignaciones_rol.push({
        id: nextAsignacionId++, usuario_id: p[0], role: p[1], allowed_markets: p[2], default_market: p[3],
        can_sell: p[4], user_status: p[5], valid_until: null, note: p[6] || null, created_by: p[7],
      });
    } else if (sql.startsWith('INSERT INTO asignaciones_rol')) {
      state.asignaciones_rol.push({
        id: nextAsignacionId++, usuario_id: p[0], role: p[1], allowed_markets: p[2], default_market: p[3],
        can_sell: p[4], user_status: 'activo', valid_until: null, note: null, created_by: p[5],
      });
    } else if (sql.startsWith("UPDATE asignaciones_rol SET valid_until")) {
      const a = state.asignaciones_rol.find((x) => x.id === p[0]);
      if (a) a.valid_until = '2026-09-02 12:00:00';
    } else if (sql.startsWith('INSERT INTO equipos')) {
      state.equipos.push({ id: p[0], nombre: p[1], mercado: p[2], estado: 'activo', created_by: p[3] });
    } else if (sql.startsWith('UPDATE equipos SET estado')) {
      const e = state.equipos.find((x) => x.id === p[1]);
      if (e) e.estado = p[0];
    } else if (sql.startsWith('INSERT INTO equipo_miembros')) {
      state.equipo_miembros.push({ id: p[0], equipo_id: p[1], usuario_email: p[2], valid_from: '2026-09-02 00:00:00', valid_until: null, created_by: p[3] });
    } else if (sql.startsWith("UPDATE equipo_miembros SET valid_until")) {
      const m = state.equipo_miembros.find((x) => x.id === p[0]);
      if (m) m.valid_until = '2026-09-02 12:00:00';
    } else if (sql.startsWith('INSERT INTO equipo_supervisores')) {
      state.equipo_supervisores.push({ id: p[0], equipo_id: p[1], usuario_email: p[2], es_principal: p[3], valid_from: '2026-09-02 00:00:00', valid_until: null, created_by: p[4] });
    } else if (sql.startsWith("UPDATE equipo_supervisores SET es_principal = 0")) {
      state.equipo_supervisores.filter((s) => s.equipo_id === p[0] && !s.valid_until).forEach((s) => { s.es_principal = 0; });
    } else if (sql.startsWith('UPDATE equipo_supervisores SET es_principal = 1')) {
      const s = state.equipo_supervisores.find((x) => x.id === p[0]);
      if (s) s.es_principal = 1;
    } else if (sql.startsWith("UPDATE equipo_supervisores SET valid_until")) {
      const s = state.equipo_supervisores.find((x) => x.id === p[0]);
      if (s) s.valid_until = '2026-09-02 12:00:00';
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6], motivo_nota: p[7] });
    } else if (!runCascadeUpdate(state, sql, p)) {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  function runSelect(sql, p) {
    if (sql.startsWith('SELECT id FROM usuarios WHERE email')) {
      const u = state.usuarios.find((x) => x.email === p[0]);
      return u ? [{ id: u.id }] : [];
    }
    if (sql.startsWith('SELECT id, nombre, documento_identidad, telefono, whatsapp_laboral, acceso_estado FROM usuarios WHERE email')) {
      const u = state.usuarios.find((x) => x.email === p[0]);
      return u ? [u] : [];
    }
    if (sql.includes('FROM usuarios u') && sql.includes('LEFT JOIN asignaciones_rol a')) {
      return state.usuarios.map((u) => {
        const a = vigente(state.asignaciones_rol.filter((x) => x.usuario_id === u.id))[0] || null;
        return { ...u, role: a?.role || null, allowed_markets: a?.allowed_markets || null, default_market: a?.default_market || null, can_sell: a?.can_sell || 0, user_status: a?.user_status || null, valid_from: a?.valid_from || null };
      });
    }
    if (sql.startsWith('SELECT id, role, allowed_markets, can_sell, user_status FROM asignaciones_rol')) {
      return vigente(state.asignaciones_rol.filter((a) => a.usuario_id === p[0]));
    }
    if (sql.startsWith('SELECT id, nombre, estado FROM equipos WHERE id')) {
      const e = state.equipos.find((x) => x.id === p[0]);
      return e ? [e] : [];
    }
    if (sql.startsWith('SELECT id FROM equipos WHERE id')) {
      const e = state.equipos.find((x) => x.id === p[0]);
      return e ? [{ id: e.id }] : [];
    }
    if (sql.startsWith('SELECT id, nombre, mercado, estado FROM equipos WHERE mercado IN')) {
      const mercados = sql.includes("AND estado = 'activo'") ? p : p; // mercados siempre van primero.
      const soloActivos = sql.includes("AND estado = 'activo'");
      const nMercados = p.length; // todos los binds acá son mercados (sin filtro de estado por parámetro).
      return state.equipos.filter((e) => p.includes(e.mercado) && (!soloActivos || e.estado === 'activo'));
    }
    if (sql.includes('FROM equipo_miembros m') && sql.includes('LEFT JOIN usuarios u')) {
      return vigente(state.equipo_miembros.filter((m) => m.equipo_id === p[0])).map((m) => ({ ...m, usuario_nombre: state.usuarios.find((u) => u.email === m.usuario_email)?.nombre || null }));
    }
    if (sql.startsWith('SELECT id FROM equipo_miembros WHERE equipo_id') && sql.includes('LIMIT 1')) {
      const rows = vigente(state.equipo_miembros.filter((m) => m.equipo_id === p[0] && m.usuario_email === p[1]));
      return rows.length ? [{ id: rows[0].id }] : [];
    }
    if (sql.startsWith('SELECT id FROM equipo_miembros WHERE equipo_id')) {
      const rows = vigente(state.equipo_miembros.filter((m) => m.equipo_id === p[0] && m.usuario_email === p[1]));
      return rows.length ? [{ id: rows[0].id }] : [];
    }
    if (sql.includes('FROM equipo_supervisores s') && sql.includes('LEFT JOIN usuarios u')) {
      return vigente(state.equipo_supervisores.filter((s) => s.equipo_id === p[0])).map((s) => ({ ...s, usuario_nombre: state.usuarios.find((u) => u.email === s.usuario_email)?.nombre || null }));
    }
    if (sql.startsWith('SELECT id FROM equipo_supervisores WHERE equipo_id') && sql.includes('LIMIT 1')) {
      const rows = vigente(state.equipo_supervisores.filter((s) => s.equipo_id === p[0] && s.usuario_email === p[1]));
      return rows.length ? [{ id: rows[0].id }] : [];
    }
    if (sql.startsWith('SELECT id FROM equipo_supervisores WHERE equipo_id')) {
      const rows = vigente(state.equipo_supervisores.filter((s) => s.equipo_id === p[0] && s.usuario_email === p[1]));
      return rows.length ? [{ id: rows[0].id }] : [];
    }
    throw new Error('consulta inesperada en test: ' + sql);
  }

  return {
    _state: state,
    prepare: (sql) => makeStatement(sql),
    // RIO-119 (tercer bloque — identidad estable): 'cambiar-correo' usa
    // transaction()/db.batch() para cascadear el cambio de correo de forma
    // atómica — D1 real ejecuta secuencialmente y revierte todo si una
    // falla (RIO-108); acá alcanza con ejecutar cada sentencia en orden.
    batch: async (statements) => {
      for (const stmt of statements) await stmt.run();
      return statements.map(() => ({ success: true }));
    },
  };
}

// Cascade UPDATE genérico: cubre cualquier `UPDATE <tabla> SET <col> = ?
// WHERE <col> = ?` de TABLAS_IDENTIDAD_VIGENTE (personas/[email]/index.js)
// sin tener que hardcodear cada tabla — las tablas de negocio (ventas,
// comisiones, etc.) no son el foco de este archivo de pruebas, así que se
// inicializan vacías bajo demanda.
function runCascadeUpdate(state, sql, p) {
  const m = sql.match(/^UPDATE (\w+) SET (\w+) = \? WHERE \2 = \?$/);
  if (!m) return false;
  const [, tabla, columna] = m;
  state[tabla] = state[tabla] || [];
  state[tabla].forEach((row) => { if (row[columna] === p[1]) row[columna] = p[0]; });
  return true;
}

// Clave de prueba fija — nunca la real de Preview/Producción (ver
// tests/crypto.test.js) — necesaria porque personas/index.js y
// personas/[email]/index.js cifran documentoIdentidad (RIO-119, tercer
// bloque, RUT/DNI protegido).
const DATOS_SENSIBLES_KEY_V1_TEST = 'ooairIYpX84V8LsrlfjzFZmTUxS3AbLdo9A+YIEqdAM=';

function fakeContext({ method = 'GET', url = 'https://rioimpulsodigital.com/interno/api/personas', body, roleIdentity: ri, db, params = {} } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request(url, init),
    env: { DB: db, DATOS_SENSIBLES_KEY_V1: DATOS_SENSIBLES_KEY_V1_TEST },
    params,
    data: { requestId: 'req-personas-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

// ── Personas ──────────────────────────────────────────────────────────

test('POST /personas — admin crea un perfil nuevo con su asignación inicial', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  const response = await personasHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin,
    body: { email: 'nueva@example.com', nombre: 'Persona Nueva', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, documentoIdentidad: '12.345.678-9', telefono: '+56911112222' },
  }));
  assert.equal(response.status, 201);
  assert.equal(db._state.usuarios.length, 1);
  // RIO-119 (tercer bloque — RUT/DNI protegido): D1 nunca ve el texto
  // plano — se guarda cifrado (formato 'v<n>:iv:ciphertext').
  assert.ok(db._state.usuarios[0].documento_identidad);
  assert.notEqual(db._state.usuarios[0].documento_identidad, '12.345.678-9');
  assert.equal(db._state.usuarios[0].documento_identidad.includes('12.345.678-9'), false);
  assert.match(db._state.usuarios[0].documento_identidad, /^v1:/);
  assert.equal(db._state.asignaciones_rol.length, 1);
  assert.equal(db._state.asignaciones_rol[0].role, 'ejecutivo');
  assert.equal(db._state.eventos_historial.filter((e) => e.entidad === 'usuario').length, 1);
  assert.equal(db._state.eventos_historial.filter((e) => e.entidad === 'asignacion_rol').length, 1);
});

test('POST /personas — no admin recibe 403, no crea nada', async () => {
  const db = fakeDb();
  const ejecutivo = roleIdentity({ email: 'ejecutivo@example.com', role: 'ejecutivo', permissions: PERMISSIONS.ejecutivo });
  const response = await personasHandler(fakeContext({
    method: 'POST', db, roleIdentity: ejecutivo,
    body: { email: 'nueva@example.com', nombre: 'X', role: 'ejecutivo', allowedMarkets: ['CL'] },
  }));
  assert.equal(response.status, 403);
  assert.equal(db._state.usuarios.length, 0);
});

test('POST /personas — email duplicado es rechazado', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  const body = { email: 'repetido@example.com', nombre: 'X', role: 'ejecutivo', allowedMarkets: ['CL'] };
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body }));
  const response = await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body }));
  assert.equal(response.status, 400);
  assert.equal(db._state.usuarios.length, 1);
});

test('GET /personas — lista también un perfil sin ninguna asignación de rol (nunca se pierde de la lista)', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { email: 'sin.rol@example.com', nombre: 'Sin Rol', role: 'ejecutivo', allowedMarkets: ['CL'] } }));
  // Simula un perfil creado sin asignación todavía, insertando usuario directo sin pasar por el flujo de creación completo.
  db._state.usuarios.push({ id: 999, email: 'huerfano@example.com', nombre: 'Huérfano', documento_identidad: null, telefono: null, whatsapp_laboral: null, acceso_estado: 'perfil_creado', created_at: '2026-09-02' });

  const response = await personasHandler(fakeContext({ roleIdentity: admin, db }));
  const body = (await response.json()).data;
  assert.equal(body.personas.length, 2);
  const huerfano = body.personas.find((p) => p.email === 'huerfano@example.com');
  assert.equal(huerfano.role, null);
  assert.deepEqual(huerfano.allowedMarkets, []);
});

test('POST /personas/:email — editar-perfil actualiza y audita valor anterior/nuevo, sin versionar', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { email: 'editar@example.com', nombre: 'Nombre Viejo', role: 'ejecutivo', allowedMarkets: ['CL'] } }));

  const response = await personaEmailHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'editar@example.com' },
    body: { action: 'editar-perfil', nombre: 'Nombre Nuevo', telefono: '+56900000000', accesoEstado: 'acceso_confirmado' },
  }));
  assert.equal(response.status, 200);
  const usuario = db._state.usuarios.find((u) => u.email === 'editar@example.com');
  assert.equal(usuario.nombre, 'Nombre Nuevo');
  assert.equal(usuario.telefono, '+56900000000');
  assert.equal(usuario.acceso_estado, 'acceso_confirmado');
  // La creación del perfil también registra un evento 'usuario' (estadoNuevo
  // 'creado', sin anterior) — el de editar-perfil es el ÚLTIMO, no el primero.
  const eventosUsuario = db._state.eventos_historial.filter((e) => e.entidad === 'usuario' && e.entidad_id === 'editar@example.com');
  const evento = eventosUsuario[eventosUsuario.length - 1];
  assert.ok(evento);
  assert.ok(JSON.parse(evento.estado_anterior).nombre === 'Nombre Viejo');
  assert.ok(JSON.parse(evento.estado_nuevo).nombre === 'Nombre Nuevo');
  // Los logs/historial NUNCA filtran el RUT/DNI, ni siquiera cuando cambia.
  assert.equal(JSON.stringify(evento).includes('documentoIdentidad":'), false);
  assert.equal(evento.estado_anterior.includes('documentoIdentidad'), false);
});

test('POST /personas/:email — cambiar-asignacion NUNCA sobrescribe: cierra la vigente y crea una nueva versión', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { email: 'version@example.com', nombre: 'X', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: false } }));
  const asignacionOriginalId = db._state.asignaciones_rol[0].id;

  const response = await personaEmailHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'version@example.com' },
    body: { action: 'cambiar-asignacion', role: 'supervisor', allowedMarkets: ['CL', 'AR'], canSell: true, motivo: 'Promoción a supervisor' },
  }));
  assert.equal(response.status, 200);
  assert.equal(db._state.asignaciones_rol.length, 2, 'nunca se sobrescribe — queda la vieja cerrada más la nueva');
  const original = db._state.asignaciones_rol.find((a) => a.id === asignacionOriginalId);
  assert.ok(original.valid_until, 'la asignación original queda cerrada, nunca se borra');
  const nueva = db._state.asignaciones_rol.find((a) => a.id !== asignacionOriginalId);
  assert.equal(nueva.role, 'supervisor');
  assert.equal(nueva.valid_until, null);
});

test('POST /personas/:email — email inexistente devuelve 404', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  const response = await personaEmailHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { email: 'no-existe@example.com' }, body: { action: 'editar-perfil', nombre: 'X' } }));
  assert.equal(response.status, 404);
});

// ── RUT/DNI protegido (RIO-119, tercer bloque, 02/09/2026) ──────────────

test('revelar-documento — administración puede revelar el RUT/DNI real, y queda auditado sin exponer el valor en el propio evento', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin,
    body: { email: 'con.rut@example.com', nombre: 'Con Rut', role: 'ejecutivo', allowedMarkets: ['CL'], documentoIdentidad: '9.876.543-2' },
  }));

  const response = await personaEmailHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'con.rut@example.com' }, body: { action: 'revelar-documento' },
  }));
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.documentoIdentidad, '9.876.543-2');

  const evento = db._state.eventos_historial.find((e) => e.estado_nuevo === 'documento_revelado');
  assert.ok(evento, 'la revelación queda auditada');
  assert.equal(evento.usuario_email, admin.email);
  assert.equal(JSON.stringify(evento).includes('9.876.543-2'), false, 'el propio evento nunca contiene el valor revelado');
});

test('revelar-documento — un supervisor (no admin) recibe 403, nunca ve el RUT/DNI', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin,
    body: { email: 'con.rut2@example.com', nombre: 'X', role: 'ejecutivo', allowedMarkets: ['CL'], documentoIdentidad: '1.111.111-1' },
  }));
  const supervisor = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', permissions: PERMISSIONS.supervisor });
  const response = await personaEmailHandler(fakeContext({
    method: 'POST', db, roleIdentity: supervisor, params: { email: 'con.rut2@example.com' }, body: { action: 'revelar-documento' },
  }));
  assert.equal(response.status, 403);
});

test('GET /personas — nunca expone el RUT/DNI ni siquiera parcialmente, solo si existe uno cargado', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin,
    body: { email: 'listado.rut@example.com', nombre: 'X', role: 'ejecutivo', allowedMarkets: ['CL'], documentoIdentidad: '5.555.555-5' },
  }));
  const response = await personasHandler(fakeContext({ roleIdentity: admin, db }));
  const persona = (await response.json()).data.personas.find((p) => p.email === 'listado.rut@example.com');
  assert.equal(persona.tieneDocumento, true);
  assert.equal(persona.documentoIdentidad, undefined, 'el campo crudo nunca se serializa');
  assert.equal(JSON.stringify(persona).includes('5.555.555-5'), false);
});

// ── Identidad estable (RIO-119, tercer bloque, 02/09/2026) ──────────────

test('cambiar-correo — cascadea el nuevo correo a ventas/comisiones/equipos, y deja registro del cambio', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { email: 'viejo@example.com', nombre: 'Persona', role: 'ejecutivo', allowedMarkets: ['CL'] } }));

  // Simula relaciones ya existentes con el correo viejo, en tablas de negocio reales.
  db._state.ventas = [{ id: 'venta-1', vendedor_email: 'viejo@example.com' }];
  db._state.comisiones = [{ id: 'com-1', beneficiario_email: 'viejo@example.com' }];
  db._state.equipo_miembros.push({ id: 'm-1', equipo_id: 'eq-1', usuario_email: 'viejo@example.com', valid_from: '2026-01-01', valid_until: null, created_by: 'admin@example.com' });
  db._state.eventos_historial.push({ id: 'ev-vieja', venta_id: 'venta-1', entidad: 'componente', entidad_id: 'comp-1', estado_nuevo: 'aprobada', usuario_email: 'viejo@example.com' });

  const response = await personaEmailHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'viejo@example.com' },
    body: { action: 'cambiar-correo', nuevoEmail: 'nuevo@example.com', motivo: 'Corrección de correo' },
  }));
  assert.equal(response.status, 200);

  assert.equal(db._state.usuarios.find((u) => u.nombre === 'Persona').email, 'nuevo@example.com');
  assert.equal(db._state.ventas[0].vendedor_email, 'nuevo@example.com', 'la venta sigue vinculada a la misma persona');
  assert.equal(db._state.comisiones[0].beneficiario_email, 'nuevo@example.com', 'la comisión sigue vinculada a la misma persona');
  assert.equal(db._state.equipo_miembros.find((m) => m.id === 'm-1').usuario_email, 'nuevo@example.com', 'la membresía de equipo sigue vinculada');
  // El evento histórico YA registrado con el correo viejo NUNCA se reescribe — es un hecho congelado.
  assert.equal(db._state.eventos_historial.find((e) => e.id === 'ev-vieja').usuario_email, 'viejo@example.com', 'un evento histórico ya registrado nunca se reescribe');

  const registroCambio = db._state.usuarios_correos_historicos.find((c) => c.correo_anterior === 'viejo@example.com');
  assert.ok(registroCambio, 'el cambio de correo queda registrado, conservando el valor anterior');
  assert.equal(registroCambio.correo_nuevo, 'nuevo@example.com');
  assert.equal(registroCambio.changed_by, admin.email);
});

test('cambiar-correo — un correo ya usado por otra persona es rechazado, no cascadea nada', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { email: 'persona.a@example.com', nombre: 'A', role: 'ejecutivo', allowedMarkets: ['CL'] } }));
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { email: 'persona.b@example.com', nombre: 'B', role: 'ejecutivo', allowedMarkets: ['CL'] } }));

  const response = await personaEmailHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'persona.a@example.com' },
    body: { action: 'cambiar-correo', nuevoEmail: 'persona.b@example.com' },
  }));
  assert.equal(response.status, 400);
  assert.equal(db._state.usuarios.find((u) => u.nombre === 'A').email, 'persona.a@example.com', 'nunca cambia si el nuevo correo ya existe');
});

test('cambiar-correo — un supervisor (no admin) recibe 403', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await personasHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { email: 'protegido@example.com', nombre: 'X', role: 'ejecutivo', allowedMarkets: ['CL'] } }));
  const supervisor = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', permissions: PERMISSIONS.supervisor });
  const response = await personaEmailHandler(fakeContext({
    method: 'POST', db, roleIdentity: supervisor, params: { email: 'protegido@example.com' }, body: { action: 'cambiar-correo', nuevoEmail: 'otro@example.com' },
  }));
  assert.equal(response.status, 403);
  assert.equal(db._state.usuarios.find((u) => u.nombre === 'X').email, 'protegido@example.com');
});

// ── Equipos ───────────────────────────────────────────────────────────

test('POST /equipos — admin crea un equipo nuevo', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  const response = await equiposHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: { nombre: 'Equipo Nuevo', mercado: 'CL' } }));
  assert.equal(response.status, 201);
  assert.equal(db._state.equipos.length, 1);
  assert.equal(db._state.equipos[0].estado, 'activo');
  assert.equal(db._state.eventos_historial.filter((e) => e.entidad === 'equipo').length, 1);
});

test('POST /equipos — un supervisor (no admin) no puede crear equipos', async () => {
  const db = fakeDb();
  const supervisor = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', permissions: PERMISSIONS.supervisor });
  const response = await equiposHandler(fakeContext({ method: 'POST', db, roleIdentity: supervisor, body: { nombre: 'X', mercado: 'CL' } }));
  assert.equal(response.status, 403);
  assert.equal(db._state.equipos.length, 0);
});

test('GET /equipos — por defecto solo lista equipos activos; con incluirInactivos=1 también los inactivos', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  db._state.equipos.push({ id: 'eq-1', nombre: 'Activo', mercado: 'CL', estado: 'activo', created_by: 'admin@example.com' });
  db._state.equipos.push({ id: 'eq-2', nombre: 'Inactivo', mercado: 'CL', estado: 'inactivo', created_by: 'admin@example.com' });

  const soloActivos = await equiposHandler(fakeContext({ db, roleIdentity: admin, url: 'https://rioimpulsodigital.com/interno/api/equipos' }));
  const bodyActivos = (await soloActivos.json()).data;
  assert.equal(bodyActivos.equipos.length, 1);

  const conInactivos = await equiposHandler(fakeContext({ db, roleIdentity: admin, url: 'https://rioimpulsodigital.com/interno/api/equipos?incluirInactivos=1' }));
  const bodyTodos = (await conInactivos.json()).data;
  assert.equal(bodyTodos.equipos.length, 2);
});

test('POST /equipos/:id — desactivar y reactivar un equipo, nunca borra sus miembros', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  db._state.equipos.push({ id: 'eq-1', nombre: 'Equipo', mercado: 'CL', estado: 'activo', created_by: 'admin@example.com' });
  db._state.equipo_miembros.push({ id: 'm-1', equipo_id: 'eq-1', usuario_email: 'ejecutivo@example.com', valid_from: '2026-09-01', valid_until: null, created_by: 'admin@example.com' });

  const desactivar = await equipoIdHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'desactivar' } }));
  assert.equal(desactivar.status, 200);
  assert.equal(db._state.equipos[0].estado, 'inactivo');
  assert.equal(db._state.equipo_miembros.length, 1, 'los miembros no se tocan al desactivar el equipo');

  const activar = await equipoIdHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'activar' } }));
  assert.equal(activar.status, 200);
  assert.equal(db._state.equipos[0].estado, 'activo');
});

test('miembros — agregar y quitar: quitar CIERRA la fila vigente (valid_until), nunca la borra', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  db._state.equipos.push({ id: 'eq-1', nombre: 'Equipo', mercado: 'CL', estado: 'activo', created_by: 'admin@example.com' });
  db._state.usuarios.push({ id: 1, email: 'ejecutivo@example.com', nombre: 'Ejecutivo', acceso_estado: 'perfil_creado' });

  const agregar = await miembrosHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'agregar', usuarioEmail: 'ejecutivo@example.com' } }));
  assert.equal(agregar.status, 201);
  assert.equal(db._state.equipo_miembros.length, 1);

  const listar = await miembrosHandler(fakeContext({ db, roleIdentity: admin, params: { id: 'eq-1' } }));
  const listado = (await listar.json()).data;
  assert.equal(listado.miembros.length, 1);
  assert.equal(listado.miembros[0].usuarioNombre, 'Ejecutivo');

  const duplicado = await miembrosHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'agregar', usuarioEmail: 'ejecutivo@example.com' } }));
  assert.equal(duplicado.status, 400, 'no puede quedar dos veces como miembro vigente del mismo equipo');

  const quitar = await miembrosHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'quitar', usuarioEmail: 'ejecutivo@example.com' } }));
  assert.equal(quitar.status, 200);
  assert.equal(db._state.equipo_miembros.length, 1, 'la fila sigue existiendo — nunca se borra');
  assert.ok(db._state.equipo_miembros[0].valid_until, 'queda cerrada con valid_until');
});

test('supervisores — un equipo puede tener más de un supervisor vigente, pero como máximo un principal a la vez', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  db._state.equipos.push({ id: 'eq-1', nombre: 'Equipo', mercado: 'CL', estado: 'activo', created_by: 'admin@example.com' });
  db._state.usuarios.push({ id: 1, email: 'alberto@example.com', nombre: 'Alberto Soto' });
  db._state.usuarios.push({ id: 2, email: 'nueva.supervisora@example.com', nombre: 'Nueva Supervisora' });

  await supervisoresHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'agregar', usuarioEmail: 'alberto@example.com', esPrincipal: true } }));
  await supervisoresHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'agregar', usuarioEmail: 'nueva.supervisora@example.com' } }));

  let listar = await supervisoresHandler(fakeContext({ db, roleIdentity: admin, params: { id: 'eq-1' } }));
  let listado = (await listar.json()).data.supervisores;
  assert.equal(listado.length, 2, 'dos supervisores vigentes a la vez, es válido');
  assert.equal(listado.filter((s) => s.esPrincipal).length, 1, 'solo uno es principal');
  assert.equal(listado.find((s) => s.esPrincipal).usuarioEmail, 'alberto@example.com');

  await supervisoresHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'marcar-principal', usuarioEmail: 'nueva.supervisora@example.com' } }));
  listar = await supervisoresHandler(fakeContext({ db, roleIdentity: admin, params: { id: 'eq-1' } }));
  listado = (await listar.json()).data.supervisores;
  assert.equal(listado.filter((s) => s.esPrincipal).length, 1, 'sigue siendo uno solo — el nuevo desmarca al anterior');
  assert.equal(listado.find((s) => s.esPrincipal).usuarioEmail, 'nueva.supervisora@example.com');
});

test('supervisores — quitar un supervisor cierra su fila vigente, nunca la borra', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  db._state.equipos.push({ id: 'eq-1', nombre: 'Equipo', mercado: 'CL', estado: 'activo', created_by: 'admin@example.com' });
  await supervisoresHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'agregar', usuarioEmail: 'alberto@example.com' } }));

  const quitar = await supervisoresHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'eq-1' }, body: { action: 'quitar', usuarioEmail: 'alberto@example.com' } }));
  assert.equal(quitar.status, 200);
  assert.equal(db._state.equipo_supervisores.length, 1);
  assert.ok(db._state.equipo_supervisores[0].valid_until);
});

test('equipos/[id] y miembros/supervisores — equipo inexistente devuelve 404', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  const r1 = await equipoIdHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, params: { id: 'no-existe' }, body: { action: 'activar' } }));
  assert.equal(r1.status, 404);
  const r2 = await miembrosHandler(fakeContext({ db, roleIdentity: admin, params: { id: 'no-existe' } }));
  assert.equal(r2.status, 404);
  const r3 = await supervisoresHandler(fakeContext({ db, roleIdentity: admin, params: { id: 'no-existe' } }));
  assert.equal(r3.status, 404);
});
