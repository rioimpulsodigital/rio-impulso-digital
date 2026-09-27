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
  reclamarIntentoEnvio, enviarFormularioServerSide,
} from '../functions/_shared/hubspot.js';

function fakeDb(seed = {}) {
  const state = {
    hubspot_sync: seed.hubspot_sync || [], eventos_historial: seed.eventos_historial || [],
    ventas: seed.ventas || [], clientes: seed.clientes || [], usuarios: seed.usuarios || [],
  };
  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => ({ success: true, meta: { changes: runMutation(sql, p) } }),
    };
  }
  function runSelect(sql, p) {
    if (sql.startsWith('SELECT id, estado, intentos FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado, intentos: fila.intentos }] : [];
    }
    if (sql.startsWith('SELECT id, estado FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado }] : [];
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
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('LEFT JOIN usuarios u')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      if (!v) return [];
      const c = state.clientes.find((x) => x.id === v.cliente_id);
      const u = state.usuarios.find((x) => x.email === v.vendedor_email);
      return [{
        producto: v.producto, antecedentes_kit_json: v.antecedentes_kit_json || null, nombre_proyecto: v.nombre_proyecto || null,
        negocio: c?.negocio || null, contacto_nombre: c?.contacto_nombre || null, telefono: c?.telefono || null,
        cliente_email: c?.email || null, vendedor_nombre: u?.nombre || null,
      }];
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO hubspot_sync') && sql.includes("'procesando', 'forms_api_browser'")) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: 'procesando', canal: 'forms_api_browser', intentos: 1, ultimo_intento_at: p[2], ultima_respuesta_resumen: null, created_at: p[3], updated_at: p[4] });
      return 1;
    }
    if (sql.startsWith('INSERT INTO hubspot_sync') && sql.includes("'pendiente', 'forms_api_browser'")) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: 'pendiente', canal: 'forms_api_browser', intentos: 0, ultimo_intento_at: p[2], ultima_respuesta_resumen: null, created_at: p[3], updated_at: p[4] });
      return 1;
    }
    if (sql.startsWith('INSERT INTO hubspot_sync')) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: p[2], canal: 'forms_api_browser', intentos: 1, ultimo_intento_at: p[3], ultima_respuesta_resumen: p[4] || null, created_at: p[5], updated_at: p[6] });
      return 1;
    }
    if (sql.startsWith("UPDATE hubspot_sync SET estado = 'procesando'")) {
      // reclamarIntentoEnvio: [ahora, ahora, ventaId, limiteLease] — solo
      // reclama si pendiente/error, o procesando con el lease vencido.
      const [ahora, updatedAt, ventaId, limiteLease] = p;
      const fila = state.hubspot_sync.find((h) => h.venta_id === ventaId);
      if (!fila) return 0;
      const elegible = ['pendiente', 'error'].includes(fila.estado) || (fila.estado === 'procesando' && fila.ultimo_intento_at <= limiteLease);
      if (!elegible) return 0;
      fila.estado = 'procesando'; fila.intentos += 1; fila.ultimo_intento_at = ahora; fila.updated_at = updatedAt;
      return 1;
    }
    if (sql.startsWith('UPDATE hubspot_sync SET estado')) {
      const fila = state.hubspot_sync.find((h) => h.id === p[5]);
      if (fila) Object.assign(fila, { estado: p[0], canal: 'forms_api_browser', intentos: p[1], ultimo_intento_at: p[2], ultima_respuesta_resumen: p[3] || null, updated_at: p[4] });
      return fila ? 1 : 0;
    }
    if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6] });
      return 1;
    }
    throw new Error('mutación inesperada en test: ' + sql);
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

// ── reclamarIntentoEnvio (RIO-120, corrección de confiabilidad, 11/09/2026) ──

test('reclamarIntentoEnvio() — sobre una fila "pendiente" autoriza, y deja el registro en "procesando"', async () => {
  const db = fakeDb();
  await crearRegistroPendiente(db, 'req-0', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  const r = await reclamarIntentoEnvio(db, 'req-1', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  assert.equal(r.autorizado, true);
  assert.equal(db._state.hubspot_sync[0].estado, 'procesando');
  assert.equal(db._state.hubspot_sync[0].intentos, 1);
});

test('reclamarIntentoEnvio() — sobre "enviado" (terminal) nunca autoriza', async () => {
  const db = fakeDb({ hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'enviado', canal: 'forms_api_browser', intentos: 1 }] });
  const r = await reclamarIntentoEnvio(db, 'req-1', { ventaId: 'v1', actorEmail: 'x' });
  assert.equal(r.autorizado, false);
  assert.equal(r.motivo, 'ya_enviado');
  assert.equal(db._state.hubspot_sync[0].estado, 'enviado', 'nunca lo toca');
});

test('reclamarIntentoEnvio() — dos intentos "concurrentes": el segundo, mientras el lease del primero sigue vigente, nunca se autoriza', async () => {
  const db = fakeDb();
  await crearRegistroPendiente(db, 'req-0', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  const primero = await reclamarIntentoEnvio(db, 'req-1', { ventaId: 'v1', actorEmail: 'pestaña-1' });
  const segundo = await reclamarIntentoEnvio(db, 'req-2', { ventaId: 'v1', actorEmail: 'pestaña-2' });
  assert.equal(primero.autorizado, true);
  assert.equal(segundo.autorizado, false);
  assert.equal(segundo.motivo, 'intento_en_curso');
  assert.equal(db._state.hubspot_sync[0].intentos, 1, 'el segundo intento nunca incrementa el contador — nunca "ganó" la carrera');
});

test('reclamarIntentoEnvio() — un intento abandonado (lease vencido) vuelve a quedar disponible para reclamar', async () => {
  const db = fakeDb({
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'procesando', canal: 'forms_api_browser', intentos: 1, ultimo_intento_at: '2020-01-01 00:00:00' }],
  });
  const r = await reclamarIntentoEnvio(db, 'req-1', { ventaId: 'v1', actorEmail: 'x' });
  assert.equal(r.autorizado, true, 'un intento de hace años ya venció, nunca queda bloqueado para siempre');
  assert.equal(db._state.hubspot_sync[0].intentos, 2);
});

test('reclamarIntentoEnvio() — sobre "error" autoriza (reintento normal tras un fallo)', async () => {
  const db = fakeDb({ hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', canal: 'forms_api_browser', intentos: 1, ultimo_intento_at: '2026-09-11 00:00:00' }] });
  const r = await reclamarIntentoEnvio(db, 'req-1', { ventaId: 'v1', actorEmail: 'x' });
  assert.equal(r.autorizado, true);
});

test('reclamarIntentoEnvio() — cierre/recarga después del registro "pendiente": la venta permanece y el envío sigue siendo reclamable más tarde', async () => {
  const db = fakeDb();
  await crearRegistroPendiente(db, 'req-0', { ventaId: 'v1', actorEmail: 'vendedor@example.com' });
  // Simula que nadie reclamó nada todavía (pestaña cerrada antes de intentar).
  assert.equal(db._state.hubspot_sync[0].estado, 'pendiente');
  const r = await reclamarIntentoEnvio(db, 'req-1', { ventaId: 'v1', actorEmail: 'nueva-sesion' });
  assert.equal(r.autorizado, true);
});

// ── enviarFormularioServerSide (fallback exclusivo de administración) ──

test('enviarFormularioServerSide() — arma los campos aprobados desde D1 (nunca precio/moneda/costos) y los envía a la Forms API', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', producto: 'ficha', vendedor_email: 'vendedor@example.com', cliente_id: 'c1', antecedentes_kit_json: JSON.stringify({ datosLanding: { Diferencial: 'rápido' }, datosFicha: null }) }],
    clientes: [{ id: 'c1', negocio: 'Negocio QA', contacto_nombre: 'Juan Pérez', telefono: '+56911112222', email: 'juan@qa.cl' }],
    usuarios: [{ email: 'vendedor@example.com', nombre: 'Vendedor QA' }],
  });
  const originalFetch = globalThis.fetch;
  let capturado = null;
  globalThis.fetch = async (url, opts) => { capturado = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200 }; };
  try {
    const r = await enviarFormularioServerSide(db, 'req-1', 'v1');
    assert.equal(r.ok, true);
    assert.ok(capturado.url.includes('api.hsforms.com'));
    const nombres = capturado.body.fields.map((f) => f.name);
    assert.ok(nombres.includes('email') && nombres.includes('company') && nombres.includes('respuestas_landing'));
    assert.ok(!nombres.includes('amount') && !nombres.includes('precio') && !nombres.includes('moneda'));
    assert.ok(capturado.body.context.pageUri.startsWith('https://rioimpulsodigital.com'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('enviarFormularioServerSide() — un error HTTP de HubSpot se reporta, nunca lanza', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', producto: 'ficha', vendedor_email: 'vendedor@example.com', cliente_id: 'c1' }],
    clientes: [{ id: 'c1', negocio: 'Negocio QA', email: 'juan@qa.cl' }],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    const r = await enviarFormularioServerSide(db, 'req-1', 'v1');
    assert.equal(r.ok, false);
    assert.equal(r.resumen, 'http_500');
  } finally {
    globalThis.fetch = originalFetch;
  }
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
