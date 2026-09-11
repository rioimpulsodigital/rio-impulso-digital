// Pruebas del cierre de venta integrado con el Kit Comercial — RIO-117
// (segundo bloque, 01/09/2026). Cubre: idempotencia real (doble clic,
// reintento tras timeout), "En espera de pago" como estado operativo
// calculado, vendedor resuelto exclusivamente desde la sesión, y la
// sincronización con HubSpot como una consecuencia posterior a D1 —
// nunca dos escrituras sin control, nunca bloquea ni duplica la venta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as ventasHandler } from '../functions/interno/api/ventas/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'ejecutivo.a@example.com',
    nombre: 'Ejecutivo A',
    role: 'ejecutivo',
    allowedMarkets: ['CL'],
    defaultMarket: 'CL',
    userStatus: 'activo',
    canSell: true,
    permissions: PERMISSIONS.ejecutivo,
    ...overrides,
  };
}

function fakeDb() {
  const state = {
    clientes: [], ventas: [], proyectos: [], componentes: [], pagos_esperados: [],
    planes_comision: [], asignaciones_plan_comision: [], costos_directos: [], comisiones: [],
    eventos_historial: [], usuarios: [], asignaciones_rol: [], equipo_miembros: [], equipo_supervisores: [],
    hubspot_sync: [], incidencias: [], notificaciones: [],
  };

  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => { runInsert(sql, p); return { success: true }; },
    };
  }

  function runInsert(sql, p) {
    if (sql.startsWith('INSERT INTO clientes')) {
      state.clientes.push({ id: p[0], negocio: p[1], contacto_nombre: p[2], telefono: p[3], email: p[4], mercado: p[5], datos_facturacion_ar: p[6], created_by: p[7] });
    } else if (sql.startsWith('INSERT INTO ventas')) {
      state.ventas.push({
        id: p[0], codigo_venta: p[1], cliente_id: p[2], mercado: p[3], producto: p[4], moneda: p[5],
        tipo_precio: p[6], precio_pactado: p[7], vendedor_email: p[8], equipo_id: p[9], idempotency_key: p[10],
        origen: p[11], es_demo: p[12], antecedentes_kit_json: p[13], estado_actual: 'registrada', created_at: '2026-09-01 00:00:00',
        tipo_venta: p[14], supervisor_snapshot_email: p[15], plan_supervision_snapshot_id: p[16],
        supervision_aplica: p[17], motivo_sin_supervision: p[18], porcentaje_supervision_aplicado: p[19], porcentaje_final_empresa: p[20],
      });
    } else if (sql.startsWith('INSERT INTO proyectos')) {
      state.proyectos.push({ id: p[0], venta_id: p[1], codigo_proyecto: p[2], estado_actual: 'registrado' });
    } else if (sql.startsWith('INSERT INTO componentes')) {
      state.componentes.push({ id: p[0], proyecto_id: p[1], tipo: p[2], precio_individual_referencia: p[3], precio_atribuido: p[4], estado_actual: p[5], materiales_estado: 'pendiente' });
    } else if (sql.startsWith('INSERT INTO pagos_esperados')) {
      state.pagos_esperados.push({ id: p[0], venta_id: p[1], tipo: p[2], monto: p[3], moneda: p[4], estado: 'pendiente' });
    } else if (sql.startsWith('INSERT INTO comisiones')) {
      state.comisiones.push({ id: p[0], tipo: p[1] });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_nuevo: p[5], motivo_nota: p[7] });
    } else if (sql.startsWith('INSERT INTO hubspot_sync')) {
      // RIO-120 (11/09/2026, alcance simplificado): POST /ventas solo
      // dispara crearRegistroPendiente — 'pendiente'/'forms_api_browser' van
      // literales en el SQL, no como placeholder.
      state.hubspot_sync.push({ id: p[0], venta_id: p[1], estado: 'pendiente', canal: 'forms_api_browser', intentos: 0, ultimo_intento_at: p[2], created_at: p[3], updated_at: p[4] });
    } else if (sql.startsWith('INSERT INTO notificaciones')) {
      state.notificaciones.push({
        id: p[0], tipo: p[1], clave_idempotencia: p[2], venta_id: p[3] || null, pago_id: p[4] || null,
        mercado: p[5] || null, cliente_negocio: p[6] || null, vendedor_email: p[7] || null, ruta_portal: p[8],
      });
    } else {
      throw new Error('INSERT/UPDATE inesperado en test: ' + sql);
    }
  }

  function runSelect(sql, p) {
    if (sql.startsWith('SELECT id FROM ventas WHERE idempotency_key')) {
      return state.ventas.filter((v) => v.idempotency_key === p[0]);
    }
    if (sql.startsWith('SELECT * FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) return state.componentes.filter((c) => c.proyecto_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((pg) => pg.venta_id === p[0]);
    if (sql.startsWith('SELECT estado, ultima_respuesta_resumen FROM hubspot_sync WHERE venta_id')) {
      return state.hubspot_sync.filter((h) => h.venta_id === p[0]);
    }
    if (sql.startsWith('SELECT id FROM hubspot_sync WHERE venta_id')) {
      const fila = state.hubspot_sync.find((h) => h.venta_id === p[0]);
      return fila ? [{ id: fila.id }] : [];
    }
    if (sql.startsWith('SELECT id FROM notificaciones WHERE clave_idempotencia')) {
      const fila = state.notificaciones.find((n) => n.clave_idempotencia === p[0]);
      return fila ? [{ id: fila.id }] : [];
    }
    if (sql.startsWith('SELECT modo_historico FROM ventas WHERE id')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      return v ? [{ modo_historico: v.modo_historico || null }] : [];
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.vendedor_email')) {
      return state.ventas.filter((v) => v.vendedor_email === p[0]).map((v) => ({
        ...v, negocio: state.clientes.find((c) => c.id === v.cliente_id)?.negocio,
        proyecto_estado: state.proyectos.find((pr) => pr.venta_id === v.id)?.estado_actual,
        pagos_acreditados_count: state.pagos_esperados.filter((pg) => pg.venta_id === v.id && pg.estado === 'acreditado').length,
        cancelacion_count: state.incidencias.filter((i) => i.venta_id === v.id && i.tipo === 'cancelacion').length,
      }));
    }
    if (sql.startsWith('SELECT monto FROM costos_directos WHERE componente_id')) {
      return state.costos_directos.filter((c) => c.componente_id === p[0]);
    }
    if (sql.includes('FROM usuarios u') && sql.includes('JOIN asignaciones_plan_comision ap')) return [];
    if (sql.startsWith('SELECT equipo_id FROM equipo_miembros')) return [];
    throw new Error('SELECT inesperado en test: ' + sql);
  }

  return {
    _state: state,
    prepare: (sql) => makeStatement(sql),
    batch: async (statements) => {
      for (const stmt of statements) await stmt.run();
      return statements.map(() => ({ success: true }));
    },
  };
}

function fakeContext({ method = 'POST', body, roleIdentity: ri, db, headers, env } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas', init),
    env: { DB: db, ...(env || {}) },
    params: {},
    data: { requestId: 'req-cierre-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

const CL_INDIVIDUAL = { mercado: 'CL', cliente: { negocio: 'Ferretería El Tornillo', email: 'contacto@eltornillo.cl' }, producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 50000 };

// ── Idempotencia ──────────────────────────────────────────────────────

test('idempotencia: dos solicitudes con la misma clave (doble clic) crean una sola venta', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const headers = { 'Idempotency-Key': 'clave-doble-clic-1' };

  const r1 = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db, headers }));
  const r2 = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db, headers }));

  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200, 'el reintento devuelve 200 (replay), no 201 (creación nueva)');
  const b1 = await r1.json();
  const b2 = await r2.json();
  assert.equal(b1.data.venta.id, b2.data.venta.id, 'el mismo id de venta en ambas respuestas');
  assert.equal(db._state.ventas.length, 1, 'nunca se crea una segunda venta');
  assert.equal(b2.data.replay, true);
});

test('idempotencia: un reintento tras un supuesto timeout de red (misma clave, mismo payload) tampoco duplica la venta', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const headers = { 'Idempotency-Key': 'clave-timeout-1' };

  await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db, headers }));
  // Simula que el cliente nunca recibió la respuesta y reintenta más tarde.
  const reintento = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db, headers }));

  assert.equal(reintento.status, 200);
  assert.equal(db._state.ventas.length, 1);
  assert.equal(db._state.componentes.length, 1, 'tampoco duplica el componente');
  assert.equal(db._state.pagos_esperados.length, 1, 'tampoco duplica el pago esperado');
});

test('idempotencia: sin clave, cada solicitud crea su propia venta (comportamiento normal de la API, sin cambios)', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  await ventasHandler(fakeContext({ body: { ...CL_INDIVIDUAL, cliente: { negocio: 'Otro negocio' } }, roleIdentity: ri, db }));
  assert.equal(db._state.ventas.length, 2);
});

// ── Vendedor desde la sesión, nunca desde el formulario ────────────────

test('el vendedor se resuelve exclusivamente desde la sesión (roleIdentity) — un vendedorEmail en el cuerpo se ignora por completo', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ email: 'real.vendedor@example.com' });
  const response = await ventasHandler(fakeContext({
    body: { ...CL_INDIVIDUAL, vendedorEmail: 'suplantado@example.com', ejecutivoEmail: 'suplantado@example.com' },
    roleIdentity: ri, db,
  }));
  assert.equal(response.status, 201);
  assert.equal(db._state.ventas[0].vendedor_email, 'real.vendedor@example.com');
});

// ── Estado operativo: "En espera de pago" ──────────────────────────────

test('una venta recién cerrada, sin ningún pago acreditado, aparece como "en_espera_pago" — nunca pagada o acreditada automáticamente', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const creacion = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  const creada = (await creacion.json()).data;
  assert.equal(creada.venta.estadoOperativo, 'en_espera_pago');
  assert.equal(creada.pagosEsperados[0].tipo, 'total');
  assert.equal(db._state.pagos_esperados[0].estado, 'pendiente', 'el pago nunca nace acreditado');
  assert.equal(db._state.proyectos[0].estado_actual, 'registrado', 'el proyecto nunca nace iniciado');

  const listado = await ventasHandler(fakeContext({ method: 'GET', roleIdentity: ri, db }));
  const body = await listado.json();
  assert.equal(body.data.ventas[0].estadoOperativo, 'en_espera_pago');
});

test('una vez que el pago queda acreditado, el estado operativo deja de ser "en_espera_pago" (refleja el avance real del proyecto)', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  db._state.pagos_esperados[0].estado = 'acreditado';

  const listado = await ventasHandler(fakeContext({ method: 'GET', roleIdentity: ri, db }));
  const body = await listado.json();
  assert.notEqual(body.data.ventas[0].estadoOperativo, 'en_espera_pago');
  assert.equal(body.data.ventas[0].estadoOperativo, 'registrado', 'todavía no arrancó producción, pero ya no está esperando el pago');
});

test('una venta con una incidencia de cancelación aparece como "cancelada", con prioridad sobre cualquier otro estado', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  db._state.incidencias.push({ venta_id: db._state.ventas[0].id, tipo: 'cancelacion', estado: 'abierta' });

  const listado = await ventasHandler(fakeContext({ method: 'GET', roleIdentity: ri, db }));
  const body = await listado.json();
  assert.equal(body.data.ventas[0].estadoOperativo, 'cancelada');
});

// ── origen y es_demo ────────────────────────────────────────────────────

test('origen y esDemo quedan registrados como datos estructurados, no como texto libre', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const response = await ventasHandler(fakeContext({ body: { ...CL_INDIVIDUAL, origen: 'kit_comercial', esDemo: true, tipoVenta: 'directa_administracion_sin_supervision' }, roleIdentity: admin, db }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.venta.origen, 'kit_comercial');
  assert.equal(body.data.venta.esDemo, true);
  assert.equal(db._state.ventas[0].origen, 'kit_comercial');
});

test('marcar una venta como demo (esDemo) es exclusivo de admin — un ejecutivo recibe 403', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ body: { ...CL_INDIVIDUAL, esDemo: true }, roleIdentity: ri, db }));
  assert.equal(response.status, 403);
  assert.equal(db._state.ventas.length, 0, 'no se crea nada — el rechazo es antes de escribir');
});

// ── Antecedentes del Kit (RIO-117, corrección tras validación real) ────
// El historial muestra una línea corta y fija — nunca la cadena extensa
// de respuestas del Kit. El contenido categorizado completo se guarda
// aparte, estructurado, en antecedentes_kit_json.

test('antecedentesKit: el historial muestra una sola línea corta, nunca la cadena completa de respuestas', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const antecedentesKit = {
    diagnosticoComercial: { tipo: 'A', tipoNombre: 'Capacidad limitada', notas: 'Local pequeño' },
    datosLanding: { 'Diferencial': 'atención rápida' },
    datosFicha: null,
    facturacion: null,
    productoCondiciones: { 'Forma de pago': 'Mercado Pago (link)' },
  };
  const response = await ventasHandler(fakeContext({
    body: { ...CL_INDIVIDUAL, antecedentesKit },
    roleIdentity: ri, db,
  }));
  assert.equal(response.status, 201);
  const evento = db._state.eventos_historial.find((e) => e.entidad === 'venta' && e.estado_nuevo === 'antecedente');
  assert.ok(evento, 'se registra un evento de antecedente');
  assert.equal(evento.motivo_nota, 'Venta registrada desde el Kit Comercial');
  assert.ok(!evento.motivo_nota.includes('atención rápida'), 'el historial nunca muestra el contenido detallado');
  // El contenido completo, categorizado, vive aparte — nunca reemplaza los campos estructurados.
  assert.equal(JSON.parse(db._state.ventas[0].antecedentes_kit_json).datosLanding['Diferencial'], 'atención rápida');
  assert.equal(db._state.ventas[0].producto, 'ficha');
  assert.equal(db._state.ventas[0].precio_pactado, 50000);
});

test('antecedentesKit ausente: no se registra ningún evento de antecedente ni antecedentes_kit_json', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ body: { ...CL_INDIVIDUAL }, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  assert.ok(!db._state.eventos_historial.some((e) => e.entidad === 'venta' && e.estado_nuevo === 'antecedente'));
  assert.equal(db._state.ventas[0].antecedentes_kit_json, null);
});

// ── HubSpot (RIO-120, 11/09/2026 — alcance redefinido por Brenda): el
// backend YA NO llama a HubSpot — solo crea el registro 'pendiente'
// durable. El envío real del formulario lo hace el navegador, DESPUÉS de
// esta respuesta (ver kit-venta-ficha-y-landing-page.html, probado con
// Playwright) — acá solo se verifica que D1/el registro nunca dependan de
// eso, y nunca se llama a fetch desde el servidor. ──────────────────────

test('HubSpot: POST /ventas nunca llama a fetch — el envío del formulario es responsabilidad exclusiva del navegador', async () => {
  let fetchLlamado = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchLlamado = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const db = fakeDb();
    const ri = roleIdentity();
    const response = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.data.hubspotSync.estado, 'pendiente');
    assert.equal(fetchLlamado, false, 'el servidor nunca intenta contactar a HubSpot');
    assert.equal(db._state.hubspot_sync[0].estado, 'pendiente');
    assert.equal(db._state.hubspot_sync[0].canal, 'forms_api_browser');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HubSpot: la venta queda guardada en D1 con su registro "pendiente" incluso si HubSpot está completamente inalcanzable (irrelevante para el servidor)', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.ventas.length, 1);
  assert.equal(db._state.hubspot_sync.length, 1);
});

test('HubSpot: los datos demo NUNCA generan el registro "pendiente"', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const response = await ventasHandler(fakeContext({
    body: { ...CL_INDIVIDUAL, esDemo: true, tipoVenta: 'directa_administracion_sin_supervision' },
    roleIdentity: admin, db,
  }));
  const body = await response.json();
  assert.equal(body.data.hubspotSync, null);
  assert.equal(db._state.hubspot_sync.length, 0);
});

test('HubSpot: un reintento por doble clic/timeout (misma Idempotency-Key) nunca crea un segundo registro "pendiente"', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const headers = { 'Idempotency-Key': 'clave-doble-clic-hubspot' };
  await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db, headers }));
  const reintento = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db, headers }));
  assert.equal(reintento.status, 200, 'replay, no una creación nueva');
  assert.equal(db._state.hubspot_sync.length, 1, 'nunca un segundo registro para la misma venta');
});

test('HubSpot: la notificación interna "venta_registrada" se crea para Administración en toda venta real', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  const notif = db._state.notificaciones.find((n) => n.tipo === 'venta_registrada');
  assert.ok(notif, 'se crea la notificación obligatoria de venta registrada');
  assert.equal(notif.vendedor_email, ri.email);
});

test('HubSpot: una venta demo NUNCA genera la notificación "venta_registrada"', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  await ventasHandler(fakeContext({ body: { ...CL_INDIVIDUAL, esDemo: true, tipoVenta: 'directa_administracion_sin_supervision' }, roleIdentity: admin, db }));
  assert.equal(db._state.notificaciones.length, 0);
});

// ── Pack vs individual (ya cubierto en tests/ventas.test.js — se repite acá
//    en el contexto específico del cierre para dejar la cobertura explícita
//    junto al resto de las pruebas obligatorias de esta corrección) ──

test('un producto individual crea solamente su propio componente, con snapshot de precio/moneda/mercado', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  const body = await response.json();
  assert.equal(body.data.componentes.length, 1);
  assert.equal(body.data.venta.moneda, 'CLP');
  assert.equal(body.data.venta.mercado, 'CL');
});
