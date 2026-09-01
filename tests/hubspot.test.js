// Pruebas de functions/_shared/hubspot.js — RIO-117 (segundo bloque).
// Alcance deliberadamente acotado (ver el archivo): el contrato y
// registro de sincronización, NO la integración segura server-to-server
// de RIO-120. Estas pruebas verifican la propiedad que realmente importa
// para el cierre de venta: reintentar la sincronización nunca toca la
// venta en D1 (son sistemas completamente desacoplados) y el registro de
// intentos siempre queda auditable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentarSincronizarHubSpot, obtenerEstadoSincronizacion } from '../functions/_shared/hubspot.js';

function fakeDb() {
  const state = { hubspot_sync: [] };
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
    if (sql.startsWith('SELECT id, intentos FROM hubspot_sync WHERE venta_id')) {
      return state.hubspot_sync.filter((h) => h.venta_id === p[0]);
    }
    if (sql.startsWith('SELECT * FROM hubspot_sync WHERE venta_id')) {
      return state.hubspot_sync.filter((h) => h.venta_id === p[0]);
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO hubspot_sync')) {
      // `intentos` va literal (1) en el SQL de la primera inserción, no
      // como placeholder — el bind real es [id, venta_id, estado, resumen, updated_at].
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: p[2], intentos: 1, ultima_respuesta_resumen: p[3], updated_at: p[4] });
    } else if (sql.startsWith('UPDATE hubspot_sync')) {
      const row = state.hubspot_sync.find((h) => h.id === p[4]);
      if (row) { row.estado = p[0]; row.intentos = p[1]; row.ultima_respuesta_resumen = p[2]; row.updated_at = p[3]; }
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

test('intentarSincronizarHubSpot() — un reintento tras un fallo actualiza la MISMA fila (nunca crea una segunda), y suma intentos', async () => {
  const db = fakeDb();
  const originalFetch = globalThis.fetch;
  let llamadas = 0;
  globalThis.fetch = async () => { llamadas++; return llamadas === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }; };
  try {
    const primero = await intentarSincronizarHubSpot(db, 'req-1', { ventaId: 'v1', fields: [{ objectTypeId: '0-1', name: 'company', value: 'x' }] });
    assert.equal(primero.estado, 'fallido');
    assert.equal(db._state.hubspot_sync.length, 1);
    assert.equal(db._state.hubspot_sync[0].intentos, 1);

    const reintento = await intentarSincronizarHubSpot(db, 'req-2', { ventaId: 'v1', fields: [{ objectTypeId: '0-1', name: 'company', value: 'x' }] });
    assert.equal(reintento.estado, 'exitoso');
    assert.equal(db._state.hubspot_sync.length, 1, 'sigue habiendo una sola fila — nunca duplica el registro de sincronización');
    assert.equal(db._state.hubspot_sync[0].intentos, 2);
    assert.equal(db._state.hubspot_sync[0].estado, 'exitoso');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('intentarSincronizarHubSpot() — nunca lanza una excepción hacia el llamador ni ante un error de red', async () => {
  const db = fakeDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const resultado = await intentarSincronizarHubSpot(db, 'req-1', { ventaId: 'v1', fields: [{ objectTypeId: '0-1', name: 'company', value: 'x' }] });
    assert.equal(resultado.estado, 'fallido');
    assert.equal(resultado.resumen, 'error_red');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('obtenerEstadoSincronizacion() — devuelve null si nunca se intentó sincronizar esta venta', async () => {
  const db = fakeDb();
  const estado = await obtenerEstadoSincronizacion(db, 'req-1', 'venta-sin-intentos');
  assert.equal(estado, null);
});
