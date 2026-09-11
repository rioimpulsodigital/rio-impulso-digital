// Pruebas de /interno/api/hubspot-sync — RIO-120 (11/09/2026). Exclusivo
// de administración; el vendedor nunca accede a esta ruta (403). Cubre:
// listado, filtro por error, reintento, descarte auditado, protección de
// las filas legacy de Forms API (nunca se reintentan ni descartan desde
// acá — quedan intactas para auditoría, ver la incidencia del 1/09 y 3/09
// documentada en RIO-120).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as listHandler } from '../functions/interno/api/hubspot-sync/index.js';
import { onRequest as accionHandler } from '../functions/interno/api/hubspot-sync/[ventaId]/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'ejecutivo.a@example.com', nombre: 'Ejecutivo A', role: 'ejecutivo',
    allowedMarkets: ['CL'], defaultMarket: 'CL', userStatus: 'activo', canSell: true,
    permissions: PERMISSIONS.ejecutivo, ...overrides,
  };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb(seed = {}) {
  const state = {
    ventas: seed.ventas || [], clientes: seed.clientes || [], usuarios: seed.usuarios || [],
    hubspot_sync: seed.hubspot_sync || [], eventos_historial: seed.eventos_historial || [],
  };
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
    if (sql.includes('FROM hubspot_sync hs JOIN ventas v') && sql.includes("estado IN ('error', 'reintento_pendiente')")) {
      return state.hubspot_sync.filter((h) => ['error', 'reintento_pendiente'].includes(h.estado)).map(enrich);
    }
    if (sql.includes('FROM hubspot_sync hs JOIN ventas v')) {
      return state.hubspot_sync.map(enrich);
    }
    if (sql.startsWith('SELECT id FROM ventas WHERE id')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      return v ? [{ id: v.id }] : [];
    }
    if (sql.startsWith('SELECT * FROM hubspot_sync WHERE venta_id')) {
      return state.hubspot_sync.filter((h) => h.venta_id === p[0]);
    }
    if (sql.startsWith('SELECT id, estado FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado }] : [];
    }
    if (sql.startsWith('SELECT id, estado, intentos, canal FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, estado: fila.estado, intentos: fila.intentos, canal: fila.canal }] : [];
    }
    if (sql.startsWith('SELECT id, intentos, estado FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id, intentos: fila.intentos, estado: fila.estado }] : [];
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.id = ?')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      if (!v) return [];
      const c = state.clientes.find((x) => x.id === v.cliente_id);
      return [{ id: v.id, codigo_venta: v.codigo_venta, mercado: v.mercado, producto: v.producto, moneda: v.moneda, precio_pactado: v.precio_pactado, vendedor_email: v.vendedor_email, estado_actual: v.estado_actual, antecedentes_kit_json: null, nombre_proyecto: null, negocio: c?.negocio || null, contacto_nombre: null, telefono: null, cliente_email: c?.email || null, vendedor_nombre: null, proyecto_estado: null }];
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function enrich(h) {
    const v = state.ventas.find((x) => x.id === h.venta_id);
    const c = v ? state.clientes.find((x) => x.id === v.cliente_id) : null;
    return { ...h, codigo_venta: v?.codigo_venta, venta_vendedor_email: v?.vendedor_email, venta_created_at: v?.created_at, negocio: c?.negocio };
  }
  function runMutation(sql, p) {
    if (sql.startsWith("UPDATE hubspot_sync SET estado = 'descartado'")) {
      const fila = state.hubspot_sync.find((h) => h.id === p[4]);
      if (fila) Object.assign(fila, { estado: 'descartado', motivo_descarte: p[0], descartado_por: p[1], descartado_at: p[2], updated_at: p[3] });
    } else if (sql.startsWith('UPDATE hubspot_sync SET proximo_reintento_at')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[1]);
      if (fila) fila.proximo_reintento_at = p[0];
    } else if (sql.startsWith('UPDATE hubspot_sync SET estado')) {
      const fila = state.hubspot_sync.find((h) => h.id === p[9]);
      if (fila) Object.assign(fila, { estado: p[0], canal: p[1], intentos: p[2], ultimo_intento_at: p[3], ultima_respuesta_resumen: p[4] || null, hubspot_contact_id: p[5] || fila.hubspot_contact_id, hubspot_deal_id: p[6] || fila.hubspot_deal_id, payload_hash: p[7] || fila.payload_hash, updated_at: p[8] });
    } else if (sql.startsWith('INSERT INTO hubspot_sync')) {
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: p[2], canal: p[3], intentos: p[4], ultimo_intento_at: p[5], ultima_respuesta_resumen: p[6] || null, hubspot_contact_id: p[7] || null, hubspot_deal_id: p[8] || null, payload_hash: p[9] || null, created_at: p[10], updated_at: p[11] });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }
  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function fakeContext({ method = 'GET', body, roleIdentity: ri, db, params, url, env } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request(url || 'https://rioimpulsodigital.com/interno/api/hubspot-sync', init),
    env: { DB: db, ...(env || {}) },
    params: params || {},
    data: { requestId: 'req-hs-test', roleIdentity: ri },
  };
}

test('GET /hubspot-sync — un no-admin recibe 403', async () => {
  const db = fakeDb();
  const response = await listHandler(fakeContext({ roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('GET /hubspot-sync — admin ve el listado completo, con datos de venta y cliente resueltos', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', codigo_venta: 'V-1', vendedor_email: 'ej@example.com', cliente_id: 'c1', created_at: '2026-09-11 10:00:00' }],
    clientes: [{ id: 'c1', negocio: 'Negocio Uno' }],
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'sincronizado', canal: 'objects_api', intentos: 1, hubspot_contact_id: 'contact-1', hubspot_deal_id: 'deal-1' }],
  });
  const response = await listHandler(fakeContext({ roleIdentity: admin(), db }));
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.sincronizaciones.length, 1);
  assert.equal(body.sincronizaciones[0].codigoVenta, 'V-1');
  assert.equal(body.sincronizaciones[0].clienteNegocio, 'Negocio Uno');
  assert.equal(body.sincronizaciones[0].hubspotDealId, 'deal-1');
});

test('GET /hubspot-sync?conError=1 — filtra a error/reintento_pendiente, nunca sincronizado ni legacy', async () => {
  const db = fakeDb({
    hubspot_sync: [
      { id: 'h1', venta_id: 'v1', estado: 'sincronizado', canal: 'objects_api', intentos: 1 },
      { id: 'h2', venta_id: 'v2', estado: 'error', canal: 'objects_api', intentos: 2 },
      { id: 'h3', venta_id: 'v3', estado: 'legacy_form_accepted', canal: 'forms_api_legacy', intentos: 1 },
    ],
  });
  const response = await listHandler(fakeContext({ roleIdentity: admin(), db, url: 'https://rioimpulsodigital.com/interno/api/hubspot-sync?conError=1' }));
  const body = (await response.json()).data;
  assert.equal(body.sincronizaciones.length, 1);
  assert.equal(body.sincronizaciones[0].estado, 'error');
});

test('POST /hubspot-sync/:ventaId — un no-admin recibe 403 al intentar reintentar', async () => {
  const db = fakeDb({ ventas: [{ id: 'v1', cliente_id: 'c1' }], clientes: [{ id: 'c1', negocio: 'x', email: 'a@x.com' }] });
  const response = await accionHandler(fakeContext({ method: 'POST', body: { action: 'reintentar' }, roleIdentity: roleIdentity(), db, params: { ventaId: 'v1' } }));
  assert.equal(response.status, 403);
});

test('POST /hubspot-sync/:ventaId — venta inexistente devuelve 404', async () => {
  const db = fakeDb();
  const response = await accionHandler(fakeContext({ method: 'POST', body: { action: 'reintentar' }, roleIdentity: admin(), db, params: { ventaId: 'no-existe' } }));
  assert.equal(response.status, 404);
});

test('POST /hubspot-sync/:ventaId — reintentar sin token queda en error/token_ausente (nunca 500)', async () => {
  const db = fakeDb({ ventas: [{ id: 'v1', cliente_id: 'c1' }], clientes: [{ id: 'c1', negocio: 'x', email: 'a@x.com' }] });
  const response = await accionHandler(fakeContext({ method: 'POST', body: { action: 'reintentar' }, roleIdentity: admin(), db, params: { ventaId: 'v1' } }));
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.estado, 'error');
  assert.equal(body.resumen, 'token_ausente');
});

test('POST /hubspot-sync/:ventaId — una fila legacy (Forms API) nunca se reintenta ni se descarta desde acá', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', cliente_id: 'c1' }], clientes: [{ id: 'c1', negocio: 'x', email: 'a@x.com' }],
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'legacy_form_accepted', canal: 'forms_api_legacy', intentos: 1 }],
  });
  const reintentar = await accionHandler(fakeContext({ method: 'POST', body: { action: 'reintentar' }, roleIdentity: admin(), db, params: { ventaId: 'v1' } }));
  assert.equal(reintentar.status, 409);
  assert.equal((await reintentar.json()).error.code, 'SINCRONIZACION_LEGACY');

  const descartar = await accionHandler(fakeContext({ method: 'POST', body: { action: 'descartar', motivo: 'x' }, roleIdentity: admin(), db, params: { ventaId: 'v1' } }));
  assert.equal(descartar.status, 409);
  assert.equal(db._state.hubspot_sync[0].estado, 'legacy_form_accepted', 'nunca se modifica la fila legacy');
});

test('POST /hubspot-sync/:ventaId — descartar sin motivo se rechaza', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', cliente_id: 'c1' }], clientes: [{ id: 'c1', negocio: 'x' }],
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', canal: 'objects_api', intentos: 2 }],
  });
  const response = await accionHandler(fakeContext({ method: 'POST', body: { action: 'descartar' }, roleIdentity: admin(), db, params: { ventaId: 'v1' } }));
  assert.equal(response.status, 400);
  assert.equal(db._state.hubspot_sync[0].estado, 'error', 'no se modifica sin motivo');
});

test('POST /hubspot-sync/:ventaId — descartar con motivo queda auditado (autor, fecha) sin borrar la fila', async () => {
  const db = fakeDb({
    ventas: [{ id: 'v1', cliente_id: 'c1' }], clientes: [{ id: 'c1', negocio: 'x' }],
    hubspot_sync: [{ id: 'h1', venta_id: 'v1', estado: 'error', canal: 'objects_api', intentos: 2 }],
  });
  const response = await accionHandler(fakeContext({ method: 'POST', body: { action: 'descartar', motivo: 'Cliente desistió' }, roleIdentity: admin(), db, params: { ventaId: 'v1' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.hubspot_sync[0].estado, 'descartado');
  assert.equal(db._state.hubspot_sync[0].motivo_descarte, 'Cliente desistió');
  assert.equal(db._state.hubspot_sync[0].descartado_por, 'admin@example.com');
  assert.equal(db._state.hubspot_sync.length, 1, 'la fila nunca se borra');
});

test('POST /hubspot-sync/:ventaId — action inválida se rechaza', async () => {
  const db = fakeDb({ ventas: [{ id: 'v1', cliente_id: 'c1' }], clientes: [{ id: 'c1', negocio: 'x' }] });
  const response = await accionHandler(fakeContext({ method: 'POST', body: { action: 'inventada' }, roleIdentity: admin(), db, params: { ventaId: 'v1' } }));
  assert.equal(response.status, 400);
});

test('método no permitido (DELETE) en el listado — 405', async () => {
  const db = fakeDb();
  const response = await listHandler(fakeContext({ method: 'DELETE', roleIdentity: admin(), db }));
  assert.equal(response.status, 405);
});
