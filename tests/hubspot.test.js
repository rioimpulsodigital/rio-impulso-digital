// Pruebas de functions/_shared/hubspot.js — RIO-120 (11/09/2026, alcance
// redefinido por Brenda: se descarta la Objects API, se restaura el envío
// del formulario desde el navegador). Este módulo ya NO llama a HubSpot —
// solo guarda el registro técnico mínimo y administrativo del resultado
// que el navegador reporta (pendiente / enviado / error). Cubre:
// idempotencia (nunca duplica la fila), el estado 'enviado' es terminal
// (nunca se pisa con un resultado tardío fuera de orden), y el listado
// para el Panel Administrativo excluye los mecanismos retirados
// (Objects API / Forms API legacy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crearRegistroPendiente, registrarResultadoEnvioFormulario, obtenerEstadoSincronizacion, listarSincronizaciones,
} from '../functions/_shared/hubspot.js';

function fakeDb(seed = {}) {
  const state = { hubspot_sync: seed.hubspot_sync || [], eventos_historial: seed.eventos_historial || [] };
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
    if (sql.startsWith('SELECT id, estado, intentos FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado, intentos: fila.intentos }] : [];
    }
    if (sql.startsWith('SELECT id FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id }] : [];
    }
    if (sql.startsWith('SELECT * FROM hubspot_sync WHERE venta_id')) {
      return state.hubspot_sync.filter((h) => h.venta_id === p[0]);
    }
    if (sql.includes('FROM hubspot_sync hs JOIN ventas v')) {
      let lista = state.hubspot_sync.filter((h) => h.canal === 'forms_api_browser');
      if (sql.includes("hs.estado = 'error'")) lista = lista.filter((h) => h.estado === 'error');
      return lista.map((h) => ({ ...h, codigo_venta: 'V-TEST', venta_vendedor_email: 'x@example.com', venta_created_at: '2026-09-11 00:00:00', negocio: 'Cliente test' }));
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO hubspot_sync') && sql.includes("'pendiente', 'forms_api_browser'")) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: 'pendiente', canal: 'forms_api_browser', intentos: 0, ultimo_intento_at: p[2], ultima_respuesta_resumen: null, created_at: p[3], updated_at: p[4] });
    } else if (sql.startsWith('INSERT INTO hubspot_sync')) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: p[2], canal: 'forms_api_browser', intentos: 1, ultimo_intento_at: p[3], ultima_respuesta_resumen: p[4] || null, created_at: p[5], updated_at: p[6] });
    } else if (sql.startsWith('UPDATE hubspot_sync SET estado')) {
      const fila = state.hubspot_sync.find((h) => h.id === p[5]);
      if (fila) Object.assign(fila, { estado: p[0], canal: 'forms_api_browser', intentos: p[1], ultimo_intento_at: p[2], ultima_respuesta_resumen: p[3] || null, updated_at: p[4] });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

test('crearRegistroPendiente() — crea la fila en "pendiente", canal forms_api_browser', async () => {
  const db = fakeDb();
  const id = await crearRegistroPendiente(db, 'req-1', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  assert.equal(db._state.hubspot_sync.length, 1);
  assert.equal(db._state.hubspot_sync[0].id, id);
  assert.equal(db._state.hubspot_sync[0].estado, 'pendiente');
  assert.equal(db._state.hubspot_sync[0].canal, 'forms_api_browser');
});

test('crearRegistroPendiente() — llamarlo dos veces para la misma venta nunca crea una segunda fila', async () => {
  const db = fakeDb();
  const id1 = await crearRegistroPendiente(db, 'req-1', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  const id2 = await crearRegistroPendiente(db, 'req-2', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  assert.equal(id1, id2);
  assert.equal(db._state.hubspot_sync.length, 1);
});

test('registrarResultadoEnvioFormulario() — actualiza la fila "pendiente" existente a "enviado"', async () => {
  const db = fakeDb();
  await crearRegistroPendiente(db, 'req-0', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  await registrarResultadoEnvioFormulario(db, 'req-1', { ventaId: 'v1', estado: 'enviado', resumen: 'ok', actorEmail: 'vendedor@example.com' });
  assert.equal(db._state.hubspot_sync.length, 1, 'sigue habiendo una sola fila');
  assert.equal(db._state.hubspot_sync[0].estado, 'enviado');
  assert.equal(db._state.hubspot_sync[0].intentos, 1);
});

test('registrarResultadoEnvioFormulario() — "enviado" es terminal, un resultado tardío fuera de orden nunca lo pisa', async () => {
  const db = fakeDb();
  await crearRegistroPendiente(db, 'req-0', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  await registrarResultadoEnvioFormulario(db, 'req-1', { ventaId: 'v1', estado: 'enviado', resumen: 'ok', actorEmail: 'vendedor@example.com' });
  await registrarResultadoEnvioFormulario(db, 'req-2', { ventaId: 'v1', estado: 'error', resumen: 'http_500', actorEmail: 'vendedor@example.com' });
  assert.equal(db._state.hubspot_sync[0].estado, 'enviado', 'nunca retrocede de enviado a error');
});

test('registrarResultadoEnvioFormulario() — si no existe la fila "pendiente" (caso raro), igual crea el registro con el resultado', async () => {
  const db = fakeDb();
  const id = await registrarResultadoEnvioFormulario(db, 'req-1', { ventaId: 'v1', estado: 'error', resumen: 'preview_bloqueado', actorEmail: 'vendedor@example.com' });
  assert.ok(id);
  assert.equal(db._state.hubspot_sync.length, 1);
  assert.equal(db._state.hubspot_sync[0].estado, 'error');
  assert.equal(db._state.hubspot_sync[0].ultima_respuesta_resumen, 'preview_bloqueado');
});

test('registrarResultadoEnvioFormulario() — un estado fuera de la lista permitida se ignora, nunca escribe nada', async () => {
  const db = fakeDb();
  const resultado = await registrarResultadoEnvioFormulario(db, 'req-1', { ventaId: 'v1', estado: 'pendiente', actorEmail: 'x' });
  assert.equal(resultado, null);
  assert.equal(db._state.hubspot_sync.length, 0);
});

test('obtenerEstadoSincronizacion() — devuelve null si nunca se intentó nada para esta venta', async () => {
  const db = fakeDb();
  const estado = await obtenerEstadoSincronizacion(db, 'req-1', 'venta-sin-intentos');
  assert.equal(estado, null);
});

test('listarSincronizaciones() — solo incluye canal forms_api_browser, nunca los mecanismos retirados (objects_api / forms_api_legacy)', async () => {
  const db = fakeDb({
    hubspot_sync: [
      { id: 'h1', venta_id: 'v1', estado: 'enviado', canal: 'forms_api_browser', intentos: 1 },
      { id: 'h2', venta_id: 'v2', estado: 'error', canal: 'forms_api_browser', intentos: 2 },
      { id: 'h3', venta_id: 'v3', estado: 'sincronizado', canal: 'objects_api', intentos: 1 },
      { id: 'h4', venta_id: 'v4', estado: 'legacy_form_accepted', canal: 'forms_api_legacy', intentos: 1 },
    ],
  });
  const resultado = await listarSincronizaciones(db, 'req-1', {});
  assert.equal(resultado.length, 2);
  assert.ok(resultado.every((r) => r.canal === 'forms_api_browser'));
});

test('listarSincronizaciones() — con soloConError filtra a estado "error"', async () => {
  const db = fakeDb({
    hubspot_sync: [
      { id: 'h1', venta_id: 'v1', estado: 'enviado', canal: 'forms_api_browser', intentos: 1 },
      { id: 'h2', venta_id: 'v2', estado: 'error', canal: 'forms_api_browser', intentos: 2 },
    ],
  });
  const resultado = await listarSincronizaciones(db, 'req-1', { soloConError: true });
  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].estado, 'error');
});
