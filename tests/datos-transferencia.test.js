// Pruebas de functions/interno/api/personas/[email]/datos-transferencia/*
// — RIO-119 (tercer bloque — datos de transferencia protegidos,
// 02/09/2026). Cubre los obligatorios de Brenda: solo Administrador
// gestiona/revela, enmascarado por defecto, el valor en D1 nunca es texto
// plano, un soft-delete nunca borra la fila, y los logs nunca filtran
// información sensible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as datosTransferenciaHandler } from '../functions/interno/api/personas/[email]/datos-transferencia/index.js';
import { onRequest as datoTransferenciaIdHandler } from '../functions/interno/api/personas/[email]/datos-transferencia/[id]/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

const DATOS_SENSIBLES_KEY_V1_TEST = 'ooairIYpX84V8LsrlfjzFZmTUxS3AbLdo9A+YIEqdAM=';

function roleIdentity(overrides = {}) {
  return {
    email: 'admin@example.com', nombre: 'Admin', role: 'admin', allowedMarkets: ['CL', 'AR'],
    defaultMarket: 'CL', userStatus: 'activo', canSell: true, permissions: PERMISSIONS.admin, ...overrides,
  };
}

function fakeDb() {
  const state = { usuarios: [{ id: 1, email: 'persona@example.com' }], datos_transferencia: [], eventos_historial: [] };

  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => { runMutation(sql, p); return { success: true }; },
    };
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO datos_transferencia')) {
      state.datos_transferencia.push({
        id: p[0], usuario_email: p[1], pais: p[2], moneda: p[3], banco_proveedor: p[4], tipo_cuenta: p[5], tipo_documento: p[6],
        titular_cifrado: p[7], identificacion_cifrada: p[8], numero_cuenta_cifrado: p[9], alias_cifrado: p[10], observaciones_cifradas: p[11],
        estado: 'activo', created_by: p[12], created_at: '2026-09-02', updated_by: null, updated_at: null,
      });
    } else if (sql.startsWith("UPDATE datos_transferencia SET estado = 'inactivo'")) {
      const r = state.datos_transferencia.find((x) => x.id === p[1]);
      if (r) { r.estado = 'inactivo'; r.updated_by = p[0]; r.updated_at = '2026-09-02'; }
    } else if (sql.startsWith('UPDATE datos_transferencia SET')) {
      const r = state.datos_transferencia.find((x) => x.id === p[11]);
      if (r) Object.assign(r, {
        pais: p[0], moneda: p[1], banco_proveedor: p[2], tipo_cuenta: p[3], tipo_documento: p[4],
        titular_cifrado: p[5], identificacion_cifrada: p[6], numero_cuenta_cifrado: p[7], alias_cifrado: p[8], observaciones_cifradas: p[9],
        updated_by: p[10],
      });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6], motivo_nota: p[7] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  function runSelect(sql, p) {
    if (sql.startsWith('SELECT id FROM usuarios WHERE email')) {
      const u = state.usuarios.find((x) => x.email === p[0]);
      return u ? [{ id: u.id }] : [];
    }
    if (sql.startsWith("SELECT * FROM datos_transferencia WHERE usuario_email") && sql.includes("estado = 'activo'")) {
      return state.datos_transferencia.filter((r) => r.usuario_email === p[0] && r.estado === 'activo');
    }
    if (sql.startsWith('SELECT * FROM datos_transferencia WHERE id')) {
      const r = state.datos_transferencia.find((x) => x.id === p[0] && x.usuario_email === p[1]);
      return r ? [r] : [];
    }
    throw new Error('consulta inesperada en test: ' + sql);
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'GET', url = 'https://rioimpulsodigital.com/interno/api/personas/persona@example.com/datos-transferencia', body, roleIdentity: ri, db, params = { email: 'persona@example.com' } } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request(url, init),
    env: { DB: db, DATOS_SENSIBLES_KEY_V1: DATOS_SENSIBLES_KEY_V1_TEST },
    params,
    data: { requestId: 'req-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

const REGISTRO_BASE = {
  pais: 'CL', moneda: 'CLP', bancoProveedor: 'Banco Ficticio', tipoCuenta: 'corriente', tipoDocumento: 'RUT',
  titular: 'Julia Pérez', identificacion: '12.345.678-9', numeroCuenta: '000111222333', alias: 'julia.perez.rio', observaciones: 'Cuenta principal',
};

test('POST .../datos-transferencia — admin crea un registro; D1 nunca ve ningún valor sensible en texto plano', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  const response = await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));
  assert.equal(response.status, 201);
  const registro = db._state.datos_transferencia[0];
  for (const [campo, valor] of [
    ['titular_cifrado', REGISTRO_BASE.titular], ['identificacion_cifrada', REGISTRO_BASE.identificacion],
    ['numero_cuenta_cifrado', REGISTRO_BASE.numeroCuenta], ['alias_cifrado', REGISTRO_BASE.alias], ['observaciones_cifradas', REGISTRO_BASE.observaciones],
  ]) {
    assert.ok(registro[campo], campo + ' debe tener un valor cifrado');
    assert.equal(registro[campo].includes(valor), false, campo + ' nunca contiene el texto original');
    assert.match(registro[campo], /^v1:/);
  }
  // Metadatos no sensibles quedan sin cifrar, tal cual.
  assert.equal(registro.banco_proveedor, 'Banco Ficticio');
  assert.equal(registro.pais, 'CL');
});

test('POST .../datos-transferencia — un supervisor (no admin) recibe 403, no crea nada', async () => {
  const db = fakeDb();
  const supervisor = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', permissions: PERMISSIONS.supervisor });
  const response = await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: supervisor, body: REGISTRO_BASE }));
  assert.equal(response.status, 403);
  assert.equal(db._state.datos_transferencia.length, 0);
});

test('GET .../datos-transferencia — la lista SIEMPRE viene enmascarada, nunca descifra', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));

  const response = await datosTransferenciaHandler(fakeContext({ db, roleIdentity: admin }));
  const body = (await response.json()).data;
  assert.equal(body.datosTransferencia.length, 1);
  const registro = body.datosTransferencia[0];
  assert.equal(registro.titular, '••••••••');
  assert.equal(registro.identificacion, '••••••••');
  assert.equal(registro.numeroCuenta, '••••••••');
  assert.equal(JSON.stringify(registro).includes('12.345.678-9'), false);
  assert.equal(JSON.stringify(registro).includes('000111222333'), false);
});

test('un supervisor no puede listar (403), nunca ve ni el estado enmascarado', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));
  const supervisor = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', permissions: PERMISSIONS.supervisor });
  const response = await datosTransferenciaHandler(fakeContext({ db, roleIdentity: supervisor }));
  assert.equal(response.status, 403);
});

test('revelar — administración puede revelar el valor real completo; el propio evento nunca lo contiene', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));
  const id = db._state.datos_transferencia[0].id;

  const response = await datoTransferenciaIdHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'persona@example.com', id }, body: { action: 'revelar' },
  }));
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.titular, REGISTRO_BASE.titular);
  assert.equal(body.identificacion, REGISTRO_BASE.identificacion);
  assert.equal(body.numeroCuenta, REGISTRO_BASE.numeroCuenta);

  const evento = db._state.eventos_historial.find((e) => e.estado_nuevo === 'datos_transferencia_revelados');
  assert.ok(evento);
  assert.equal(JSON.stringify(evento).includes(REGISTRO_BASE.identificacion), false);
  assert.equal(JSON.stringify(evento).includes(REGISTRO_BASE.numeroCuenta), false);
});

test('revelar — un vendedor (no admin) recibe 403', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));
  const id = db._state.datos_transferencia[0].id;
  const ejecutivo = roleIdentity({ email: 'ejecutivo@example.com', role: 'ejecutivo', permissions: PERMISSIONS.ejecutivo });
  const response = await datoTransferenciaIdHandler(fakeContext({
    method: 'POST', db, roleIdentity: ejecutivo, params: { email: 'persona@example.com', id }, body: { action: 'revelar' },
  }));
  assert.equal(response.status, 403);
});

test('eliminar — soft delete: la fila NUNCA se borra, solo pasa a inactivo y desaparece del listado', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));
  const id = db._state.datos_transferencia[0].id;

  const response = await datoTransferenciaIdHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'persona@example.com', id }, body: { action: 'eliminar' },
  }));
  assert.equal(response.status, 200);
  assert.equal(db._state.datos_transferencia.length, 1, 'la fila sigue existiendo');
  assert.equal(db._state.datos_transferencia[0].estado, 'inactivo');

  const listado = await datosTransferenciaHandler(fakeContext({ db, roleIdentity: admin }));
  assert.equal((await listado.json()).data.datosTransferencia.length, 0, 'un registro inactivo no aparece en el listado');
});

test('editar — reemplaza un campo cifrado sin tocar los demás, y sigue sin exponer el valor', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));
  const id = db._state.datos_transferencia[0].id;

  const response = await datoTransferenciaIdHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'persona@example.com', id }, body: { action: 'editar', numeroCuenta: '999888777666' },
  }));
  assert.equal(response.status, 200);

  const revelado = await datoTransferenciaIdHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'persona@example.com', id }, body: { action: 'revelar' },
  }));
  const body = (await revelado.json()).data;
  assert.equal(body.numeroCuenta, '999888777666');
  assert.equal(body.titular, REGISTRO_BASE.titular, 'los campos no enviados en editar quedan intactos');
});

test('registro inexistente (id de otra persona) devuelve 404, nunca datos ajenos', async () => {
  const db = fakeDb();
  const admin = roleIdentity();
  await datosTransferenciaHandler(fakeContext({ method: 'POST', db, roleIdentity: admin, body: REGISTRO_BASE }));
  db._state.usuarios.push({ id: 2, email: 'otra.persona@example.com' });
  const idAjeno = db._state.datos_transferencia[0].id;
  const response = await datoTransferenciaIdHandler(fakeContext({
    method: 'POST', db, roleIdentity: admin, params: { email: 'otra.persona@example.com', id: idAjeno }, body: { action: 'revelar' },
  }));
  assert.equal(response.status, 404, 'un id válido pero de otra persona nunca se resuelve');
});
