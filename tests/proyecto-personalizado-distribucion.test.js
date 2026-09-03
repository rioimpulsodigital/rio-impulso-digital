// Pruebas de RIO-119 (tercer bloque, item 5 — versión completa, 03/09/2026):
// plantillas económicas, bolsa de desarrollo con pools/participaciones,
// activación con snapshot inmutable, corrección administrativa auditada,
// fases enriquecidas (orden/responsable operativo/fechas), e importación
// histórica.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as plantillasHandler } from '../functions/interno/api/plantillas-distribucion/index.js';
import { onRequest as plantillaDetalleHandler } from '../functions/interno/api/plantillas-distribucion/[id]/index.js';
import { onRequest as distribucionHandler } from '../functions/interno/api/ventas/[id]/distribucion/index.js';
import { onRequest as componenteHandler } from '../functions/interno/api/ventas/[id]/componentes/[componenteId]/index.js';
import { onRequest as ventasHandler } from '../functions/interno/api/ventas/index.js';
import { onRequest as comisionesHistoricasHandler } from '../functions/interno/api/ventas/[id]/comisiones-historicas/index.js';
import { validarActivacionProyecto, evaluateComisionGate, generarComisionesDesdeDistribucion } from '../functions/_shared/comisiones.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

function roleIdentity(overrides = {}) {
  return { email: 'ejecutivo.a@example.com', role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}

function fakeDb(seed = {}) {
  const state = {
    plantillas_distribucion: [], venta_distribuciones: [], venta_participaciones: [],
    ventas: [], proyectos: [], componentes: [], clientes: [], pagos_esperados: [],
    eventos_historial: [], notificaciones: [], comisiones: [],
    proyecto_finanzas_empresa: [], comisiones_historicas: [], costos_directos: [],
    usuarios: [{ id: 1, email: 'admin@example.com', nombre: 'Admin' }],
    ...seed,
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
    if (sql.startsWith('SELECT id, producto FROM ventas WHERE id')) {
      return state.ventas.filter((v) => v.id === p[0]).map((v) => ({ id: v.id, producto: v.producto }));
    }
    if (sql.startsWith("SELECT * FROM venta_distribuciones WHERE venta_id")) {
      return state.venta_distribuciones.filter((d) => d.venta_id === p[0] && d.estado !== 'reemplazada').sort((a, b) => b.version - a.version);
    }
    if (sql.startsWith('SELECT * FROM venta_participaciones WHERE distribucion_id')) {
      return state.venta_participaciones.filter((x) => x.distribucion_id === p[0]);
    }
    if (sql.startsWith('SELECT porcentaje FROM venta_participaciones WHERE distribucion_id')) {
      return state.venta_participaciones.filter((x) => x.distribucion_id === p[0] && x.concepto === p[1]).map((x) => ({ porcentaje: x.porcentaje }));
    }
    if (sql.startsWith('SELECT * FROM plantillas_distribucion WHERE id')) {
      return state.plantillas_distribucion.filter((pl) => pl.id === p[0]);
    }
    if (sql.startsWith('SELECT id, estado FROM plantillas_distribucion WHERE id')) {
      return state.plantillas_distribucion.filter((pl) => pl.id === p[0]).map((pl) => ({ id: pl.id, estado: pl.estado }));
    }
    if (sql.startsWith('SELECT * FROM plantillas_distribucion ORDER BY')) return state.plantillas_distribucion;
    if (sql.includes('FROM componentes c JOIN proyectos p ON p.id = c.proyecto_id WHERE c.id')) {
      return state.componentes.filter((c) => c.id === p[0] && state.proyectos.find((pr) => pr.id === c.proyecto_id)?.venta_id === p[1]);
    }
    if (sql.startsWith('SELECT id FROM venta_participaciones WHERE id')) {
      return state.venta_participaciones.filter((x) => x.id === p[0] && x.distribucion_id === p[1]).map((x) => ({ id: x.id }));
    }
    if (sql.startsWith('SELECT id, vendedor_email, mercado FROM ventas WHERE id')) {
      return state.ventas.filter((v) => v.id === p[0]).map((v) => ({ id: v.id, vendedor_email: v.vendedor_email, mercado: v.mercado }));
    }
    if (sql.startsWith('SELECT * FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) return state.componentes.filter((c) => c.proyecto_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((pg) => pg.venta_id === p[0]);
    if (sql.startsWith('SELECT modo_historico FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]).map((v) => ({ modo_historico: v.modo_historico || null }));
    if (sql.startsWith('SELECT id, modo_historico FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]).map((v) => ({ id: v.id, modo_historico: v.modo_historico || null }));
    if (sql.startsWith('SELECT id FROM notificaciones WHERE clave_idempotencia')) return [];
    if (sql.startsWith('SELECT id FROM comisiones WHERE distribucion_id')) return state.comisiones.filter((c) => c.distribucion_id === p[0]).map((c) => ({ id: c.id }));
    if (sql.startsWith('SELECT * FROM comisiones WHERE distribucion_id')) return state.comisiones.filter((c) => c.distribucion_id === p[0]);
    if (sql.startsWith('SELECT moneda FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]).map((v) => ({ moneda: v.moneda }));
    if (sql.startsWith('SELECT precio_pactado, moneda FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]).map((v) => ({ precio_pactado: v.precio_pactado, moneda: v.moneda }));
    if (sql.startsWith('SELECT costos_cerrados FROM venta_distribuciones WHERE id')) return state.venta_distribuciones.filter((d) => d.id === p[0]).map((d) => ({ costos_cerrados: d.costos_cerrados || 0 }));
    if (sql.includes('FROM componentes c JOIN proyectos p ON p.id = c.proyecto_id WHERE p.venta_id')) {
      const proyectoIds = state.proyectos.filter((pr) => pr.venta_id === p[0]).map((pr) => pr.id);
      return state.componentes.filter((c) => proyectoIds.includes(c.proyecto_id));
    }
    if (sql.startsWith('SELECT monto FROM costos_directos WHERE componente_id')) return state.costos_directos.filter((c) => c.componente_id === p[0]).map((c) => ({ monto: c.monto }));
    if (sql.startsWith("SELECT monto FROM pagos_esperados WHERE venta_id") && sql.includes("estado = 'acreditado'")) {
      return state.pagos_esperados.filter((pg) => pg.venta_id === p[0] && pg.estado === 'acreditado').map((pg) => ({ monto: pg.monto }));
    }
    if (sql.startsWith('SELECT id FROM proyecto_finanzas_empresa WHERE distribucion_id')) return state.proyecto_finanzas_empresa.filter((f) => f.distribucion_id === p[0]).map((f) => ({ id: f.id }));
    if (sql.startsWith('SELECT * FROM proyecto_finanzas_empresa WHERE distribucion_id')) {
      return state.proyecto_finanzas_empresa.filter((f) => f.distribucion_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    if (sql.startsWith('SELECT * FROM comisiones_historicas WHERE venta_id')) return state.comisiones_historicas.filter((c) => c.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM comisiones WHERE id')) return state.comisiones.filter((c) => c.id === p[0]);
    throw new Error('SELECT inesperado en test: ' + sql);
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO plantillas_distribucion')) {
      state.plantillas_distribucion.push({
        id: p[0], nombre: p[1], porcentaje_comercial: p[2], porcentaje_supervision: p[3], porcentaje_desarrollo: p[4], porcentaje_empresa: p[5],
        note: p[6], created_by: p[7], estado: 'activo', created_at: '2026-09-03',
      });
    } else if (sql.startsWith('UPDATE plantillas_distribucion SET estado')) {
      const pl = state.plantillas_distribucion.find((x) => x.id === p[1]);
      if (pl) pl.estado = p[0];
    } else if (sql.startsWith('INSERT INTO clientes')) {
      state.clientes.push({ id: p[0] });
    } else if (sql.startsWith('INSERT INTO ventas')) {
      state.ventas.push({
        id: p[0], codigo_venta: p[1], producto: p[4], vendedor_email: p[8], mercado: p[3],
        nombre_proyecto: p[21] || null, distribucion_snapshot: p[24] || null, modo_historico: p[25] || null,
      });
    } else if (sql.startsWith('INSERT INTO proyectos')) {
      state.proyectos.push({ id: p[0], venta_id: p[1] });
    } else if (sql.startsWith('INSERT INTO componentes')) {
      state.componentes.push({ id: p[0], proyecto_id: p[1], tipo: p[2], precio_atribuido: p[4], estado_actual: p[5], nombre: p[6] });
    } else if (sql.startsWith('INSERT INTO pagos_esperados')) {
      state.pagos_esperados.push({ id: p[0], venta_id: p[1], monto: p[3] });
    } else if (sql.startsWith('INSERT INTO venta_distribuciones')) {
      // dos formas: definir-pools (7 cols) o corregir (9 cols, incluye version y motivo_correccion)
      const cols = sql.match(/\(([^)]+)\)/)[1].split(',').map((c) => c.trim());
      const row = { estado: 'borrador', version: 1, created_at: '2026-09-03' };
      cols.forEach((c, i) => { row[c] = p[i]; });
      state.venta_distribuciones.push(row);
    } else if (sql.startsWith("UPDATE venta_distribuciones SET plantilla_id")) {
      const d = state.venta_distribuciones.find((x) => x.id === p[4]);
      if (d) { d.plantilla_id = p[0]; d.porcentaje_comercial = p[1]; d.porcentaje_supervision = p[2]; d.porcentaje_desarrollo = p[3]; }
    } else if (sql.startsWith("UPDATE venta_distribuciones SET estado = 'confirmada'")) {
      const d = state.venta_distribuciones.find((x) => x.id === p[1]);
      if (d) { d.estado = 'confirmada'; d.confirmed_by = p[0]; d.confirmed_at = '2026-09-03'; }
    } else if (sql.startsWith("UPDATE venta_distribuciones SET estado = 'reemplazada'")) {
      const d = state.venta_distribuciones.find((x) => x.id === p[0]);
      if (d) d.estado = 'reemplazada';
    } else if (sql.startsWith('UPDATE ventas SET distribucion_snapshot')) {
      const v = state.ventas.find((x) => x.id === p[1]);
      if (v) v.distribucion_snapshot = p[0];
    } else if (sql.startsWith('INSERT INTO venta_participaciones')) {
      state.venta_participaciones.push({
        id: p[0], distribucion_id: p[1], concepto: p[2], fase_id: p[3], beneficiario_email: p[4], porcentaje: p[5], note: p[6], created_by: p[7],
      });
    } else if (sql.startsWith('DELETE FROM venta_participaciones')) {
      state.venta_participaciones = state.venta_participaciones.filter((x) => x.id !== p[0]);
    } else if (sql.startsWith('UPDATE componentes SET orden')) {
      const c = state.componentes.find((x) => x.id === p[4]);
      if (c) { c.orden = p[0]; c.responsable_operativo_email = p[1]; c.fecha_prevista = p[2]; c.fecha_real = p[3]; }
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3] });
    } else if (sql.startsWith('INSERT INTO notificaciones')) {
      state.notificaciones.push({ id: p[0] });
    } else if (sql.startsWith('INSERT INTO comisiones (')) {
      state.comisiones.push({
        id: p[0], tipo: p[1], venta_id: p[2], componente_id: p[3], beneficiario_email: p[4], porcentaje_snapshot: p[5],
        base_snapshot: p[6], monto_base: p[7], moneda: p[8], monto_comision: p[9], distribucion_id: p[10], participacion_id: p[11],
        es_estimacion: p[12], estado: 'calculada_provisional', created_at: '2026-09-03',
      });
    } else if (sql.startsWith('INSERT INTO proyecto_finanzas_empresa')) {
      state.proyecto_finanzas_empresa.push({
        id: p[0], venta_id: p[1], distribucion_id: p[2], monto_bruto: p[3], costos_directos: p[4], utilidad_neta: p[5],
        porcentaje_empresa: p[6], monto_empresa: p[7], fondos_obtenidos: p[8], moneda: p[9], es_estimacion: p[10], motivo: p[11], created_by: p[12],
        created_at: '2026-09-03T' + String(state.proyecto_finanzas_empresa.length).padStart(2, '0') + ':00:00',
      });
    } else if (sql.startsWith('INSERT INTO comisiones_historicas')) {
      state.comisiones_historicas.push({
        id: p[0], venta_id: p[1], beneficiario_email: p[2], concepto: p[3], importe_pagado: p[4], moneda: p[5],
        fecha_exacta: p[6], fecha_aproximada: p[7], evidencia: p[8], fuente: p[9], declarado_por: p[10],
        estado: 'historica_pagada_antes_incorporacion', created_at: '2026-09-03',
      });
    } else if (sql.startsWith('UPDATE venta_distribuciones SET politica_liberacion')) {
      const d = state.venta_distribuciones.find((x) => x.id === p[2]);
      if (d) { d.politica_liberacion = p[0]; d.requiere_hito_validado = p[1]; }
    } else if (sql.startsWith('UPDATE venta_distribuciones SET plazo_resguardo_activo')) {
      const d = state.venta_distribuciones.find((x) => x.id === p[5]);
      if (d) { d.plazo_resguardo_activo = p[0]; d.plazo_resguardo_dias = p[1]; d.plazo_resguardo_tipo_dias = p[2]; d.plazo_resguardo_evento_inicio = p[3]; d.plazo_resguardo_alcance = p[4]; }
    } else if (sql.startsWith("UPDATE venta_distribuciones SET costos_cerrados")) {
      const d = state.venta_distribuciones.find((x) => x.id === p[1]);
      if (d) { d.costos_cerrados = 1; d.costos_cerrados_por = p[0]; d.costos_cerrados_at = '2026-09-03'; }
    } else if (sql.startsWith('INSERT INTO costos_directos')) {
      state.costos_directos.push({ id: p[0], componente_id: p[1], tipo: p[2], monto: p[3], moneda: p[4] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  return {
    _state: state,
    prepare: (sql) => makeStatement(sql),
    batch: async (statements) => { for (const stmt of statements) await stmt.run(); return statements.map(() => ({ success: true })); },
  };
}

function fakeContext({ method = 'POST', body, roleIdentity: ri, db, params = {} }) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/x', init),
    env: { DB: db },
    params,
    data: { requestId: 'req-dist-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

// --- validarActivacionProyecto (función pura) ---

test('validarActivacionProyecto: proyecto con una sola persona recibiendo el 45% de desarrollo puede activarse', () => {
  const r = validarActivacionProyecto(
    { comercial: 25, supervision: 10, desarrollo: 45 },
    [
      { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 25 },
      { concepto: 'supervision', beneficiarioEmail: 'b@example.com', porcentaje: 10 },
      { concepto: 'desarrollo', beneficiarioEmail: 'c@example.com', porcentaje: 45 },
    ]
  );
  assert.equal(r.puedeActivarse, true);
  assert.equal(r.empresaPorcentaje, 20);
});

test('validarActivacionProyecto: el 45% de desarrollo dividido entre varias personas y fases puede activarse', () => {
  const r = validarActivacionProyecto(
    { comercial: 25, supervision: 10, desarrollo: 45 },
    [
      { concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 25 },
      { concepto: 'supervision', beneficiarioEmail: 'b@example.com', porcentaje: 10 },
      { concepto: 'desarrollo', beneficiarioEmail: 'front@example.com', porcentaje: 20, faseId: 'fase-frontend' },
      { concepto: 'desarrollo', beneficiarioEmail: 'back@example.com', porcentaje: 25, faseId: 'fase-backend' },
    ]
  );
  assert.equal(r.puedeActivarse, true);
});

test('validarActivacionProyecto: rechaza si las asignaciones de desarrollo superan el pool disponible', () => {
  const r = validarActivacionProyecto(
    { comercial: 25, supervision: 10, desarrollo: 45 },
    [
      { concepto: 'desarrollo', beneficiarioEmail: 'a@example.com', porcentaje: 30 },
      { concepto: 'desarrollo', beneficiarioEmail: 'b@example.com', porcentaje: 20 }, // 50% > 45% del pool.
    ]
  );
  assert.equal(r.puedeActivarse, false);
  assert.ok(r.errores.some((e) => e.includes('desarrollo') && e.includes('supera')));
});

test('validarActivacionProyecto: bloquea la activación si la distribución no llega a 100% (pools sin asignar completos)', () => {
  const r = validarActivacionProyecto(
    { comercial: 25, supervision: 10, desarrollo: 45 },
    [{ concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 25 }] // supervision y desarrollo sin asignar.
  );
  assert.equal(r.puedeActivarse, false);
  assert.equal(r.resumen.supervision.pendiente, 10);
  assert.equal(r.resumen.desarrollo.pendiente, 45);
});

test('validarActivacionProyecto: una participación pendiente (sin beneficiario) no genera comisión personal ni puede activarse', () => {
  const r = validarActivacionProyecto(
    { comercial: 25, supervision: 0, desarrollo: 0 },
    [{ concepto: 'comercial', beneficiarioEmail: null, porcentaje: 25 }]
  );
  assert.equal(r.puedeActivarse, false);
  assert.equal(r.resumen.comercial.pendiente, 25);
});

test('validarActivacionProyecto: componentes con porcentajes diferentes dentro del mismo pool son válidos (no reparte en partes iguales)', () => {
  const r = validarActivacionProyecto(
    { comercial: 0, supervision: 0, desarrollo: 45 },
    [
      { concepto: 'desarrollo', beneficiarioEmail: 'a@example.com', porcentaje: 5, faseId: 'fase-qa' },
      { concepto: 'desarrollo', beneficiarioEmail: 'b@example.com', porcentaje: 40, faseId: 'fase-backend' },
    ]
  );
  assert.equal(r.puedeActivarse, true);
});

test('validarActivacionProyecto: la misma persona en dos fases de desarrollo distintas no es duplicado', () => {
  const r = validarActivacionProyecto(
    { comercial: 0, supervision: 0, desarrollo: 45 },
    [
      { concepto: 'desarrollo', beneficiarioEmail: 'a@example.com', porcentaje: 20, faseId: 'fase-1' },
      { concepto: 'desarrollo', beneficiarioEmail: 'a@example.com', porcentaje: 25, faseId: 'fase-2' },
    ]
  );
  assert.equal(r.puedeActivarse, true);
});

test('validarActivacionProyecto: la misma persona/concepto/fase repetida es un duplicado real', () => {
  const r = validarActivacionProyecto(
    { comercial: 0, supervision: 0, desarrollo: 45 },
    [
      { concepto: 'desarrollo', beneficiarioEmail: 'a@example.com', porcentaje: 20, faseId: 'fase-1' },
      { concepto: 'desarrollo', beneficiarioEmail: 'a@example.com', porcentaje: 25, faseId: 'fase-1' },
    ]
  );
  assert.equal(r.puedeActivarse, false);
  assert.ok(r.errores.some((e) => e.includes('duplicada')));
});

// --- plantillas-distribucion ---

test('plantillas-distribucion: admin crea una plantilla que suma exactamente 100', async () => {
  const db = fakeDb();
  const response = await plantillasHandler(fakeContext({
    body: { nombre: 'Test', porcentajeComercial: 25, porcentajeSupervision: 10, porcentajeDesarrollo: 45, porcentajeEmpresa: 20 },
    roleIdentity: admin(), db,
  }));
  assert.equal(response.status, 201);
});

test('plantillas-distribucion: rechaza una plantilla cuyos 4 porcentajes no suman 100', async () => {
  const db = fakeDb();
  const response = await plantillasHandler(fakeContext({
    body: { nombre: 'Test', porcentajeComercial: 25, porcentajeSupervision: 10, porcentajeDesarrollo: 45, porcentajeEmpresa: 30 },
    roleIdentity: admin(), db,
  }));
  assert.equal(response.status, 400);
});

test('plantillas-distribucion: un ejecutivo no puede crear ni listar plantillas', async () => {
  const db = fakeDb();
  const r1 = await plantillasHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  assert.equal(r1.status, 403);
});

test('plantillas-distribucion/:id: desactivar nunca borra la plantilla', async () => {
  const db = fakeDb({ plantillas_distribucion: [{ id: 'pl-1', estado: 'activo' }] });
  const response = await plantillaDetalleHandler(fakeContext({ body: { action: 'desactivar' }, roleIdentity: admin(), db, params: { id: 'pl-1' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.plantillas_distribucion.length, 1);
  assert.equal(db._state.plantillas_distribucion[0].estado, 'inactivo');
});

// --- ventas/:id/distribucion ---

function seedProyectoPersonalizado(overrides = {}) {
  return {
    ventas: [{ id: 'venta-1', producto: 'proyecto_personalizado', vendedor_email: 'admin@example.com', mercado: 'CL', distribucion_snapshot: null }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1' }],
    componentes: [{ id: 'comp-frontend', proyecto_id: 'proyecto-1', tipo: 'personalizado' }],
    plantillas_distribucion: [{ id: 'pl-desarrollo', porcentaje_comercial: 25, porcentaje_supervision: 10, porcentaje_desarrollo: 45, porcentaje_empresa: 20, estado: 'activo' }],
    ...overrides,
  };
}

test('distribucion: solo aplica a proyecto_personalizado, no a un producto de catálogo', async () => {
  const db = fakeDb({ ventas: [{ id: 'venta-1', producto: 'ficha' }] });
  const response = await distribucionHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 400);
});

test('distribucion: un ejecutivo no puede ver ni definir la distribución (exclusivo de administración)', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  const response = await distribucionHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 403);
});

test('distribucion: definir-pools con plantilla resuelve los 3 porcentajes automáticamente', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  const response = await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 201);
  assert.equal(db._state.venta_distribuciones[0].porcentaje_desarrollo, 45);
});

test('distribucion: agregar-participacion respeta el pool — rechaza si desarrollo supera el 45% reservado', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'desarrollo', beneficiarioEmail: 'a@example.com', porcentaje: 30 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const response = await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'desarrollo', beneficiarioEmail: 'b@example.com', porcentaje: 20 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 400);
  assert.equal(db._state.venta_participaciones.length, 1); // la segunda fila nunca se creó.
});

test('distribucion: agregar-participacion permite dividir el 45% entre varias personas y fases, sin repartir en partes iguales', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const r1 = await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'desarrollo', beneficiarioEmail: 'front@example.com', porcentaje: 15, faseId: 'comp-frontend' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const r2 = await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'desarrollo', beneficiarioEmail: 'back@example.com', porcentaje: 30 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(db._state.venta_participaciones.length, 2);
});

test('distribucion: agregar-participacion permite dejar una parte pendiente de asignación (beneficiarioEmail null)', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const response = await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'desarrollo', porcentaje: 20 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 201);
  assert.equal(db._state.venta_participaciones[0].beneficiario_email, null);
});

test('distribucion: activar se rechaza si la distribución no cierra en 100%', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 25 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const response = await distribucionHandler(fakeContext({ body: { action: 'activar' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 409);
  assert.equal(db._state.ventas[0].distribucion_snapshot, null);
});

test('distribucion: activar guarda un snapshot inmutable cuando la distribución cierra en 100%', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 25 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'supervision', beneficiarioEmail: 'b@example.com', porcentaje: 10 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'desarrollo', beneficiarioEmail: 'c@example.com', porcentaje: 45 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const response = await distribucionHandler(fakeContext({ body: { action: 'activar' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.venta_distribuciones[0].estado, 'confirmada');
  assert.ok(db._state.ventas[0].distribucion_snapshot);
});

test('distribucion: un cambio posterior a una distribución confirmada exige "corregir" con motivo, nunca se edita in place', async () => {
  const db = fakeDb(seedProyectoPersonalizado());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 25 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'supervision', beneficiarioEmail: 'b@example.com', porcentaje: 10 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', concepto: 'desarrollo', beneficiarioEmail: 'c@example.com', porcentaje: 45 }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'activar' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));

  const sinMotivo = await distribucionHandler(fakeContext({ body: { action: 'corregir' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(sinMotivo.status, 400);

  const response = await distribucionHandler(fakeContext({ body: { action: 'corregir', motivo: 'Cambio de desarrollador confirmado por Brenda' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 201);
  const original = db._state.venta_distribuciones.find((d) => d.estado === 'reemplazada');
  const nueva = db._state.venta_distribuciones.find((d) => d.estado === 'borrador');
  assert.ok(original);
  assert.ok(nueva);
  assert.equal(nueva.version, 2);
  assert.equal(nueva.motivo_correccion, 'Cambio de desarrollador confirmado por Brenda');
  // las participaciones se copian hacia la nueva versión para seguir editando desde ahí.
  assert.equal(db._state.venta_participaciones.filter((x) => x.distribucion_id === nueva.id).length, 3);
});

// --- editar-fase ---

test('editar-fase: admin edita orden, responsable operativo y fechas sin tocar estado_actual', async () => {
  const db = fakeDb({
    ventas: [{ id: 'venta-1', vendedor_email: 'vendedor@example.com', mercado: 'CL' }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1' }],
    componentes: [{ id: 'comp-1', proyecto_id: 'proyecto-1', tipo: 'personalizado', estado_actual: 'pendiente' }],
  });
  const response = await componenteHandler(fakeContext({
    body: { action: 'editar-fase', orden: 2, responsableOperativoEmail: 'dev@example.com', fechaPrevista: '2026-10-01', fechaReal: null },
    roleIdentity: admin(), db, params: { id: 'venta-1', componenteId: 'comp-1' },
  }));
  assert.equal(response.status, 200);
  assert.equal(db._state.componentes[0].orden, 2);
  assert.equal(db._state.componentes[0].responsable_operativo_email, 'dev@example.com');
  assert.equal(db._state.componentes[0].estado_actual, 'pendiente'); // nunca tocado por editar-fase.
});

// --- proyectos históricos ---

const PROYECTO_HISTORICO_BASE = {
  mercado: 'CL', cliente: { negocio: 'Nua Bushi (ficticio)' }, producto: 'proyecto_personalizado', precioPactado: 5000000,
  nombreProyecto: 'Proyecto histórico ficticio', tipoVenta: 'directa_administracion_sin_supervision', modoHistorico: 'referencia',
};

test('proyecto histórico: se registra sin fases ni pagos (información incompleta permitida)', async () => {
  const db = fakeDb();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: PROYECTO_HISTORICO_BASE, roleIdentity: admin(), db }));
  assert.equal(response.status, 201);
  const body = (await response.json()).data;
  assert.equal(body.venta.modoHistorico, 'referencia');
});

test('proyecto histórico: no genera comisiones nuevas aunque haya un plan comercial vigente', async () => {
  const db = fakeDb({
    usuarios: [{ id: 1, email: 'admin@example.com', nombre: 'Admin' }],
    planes_comision: [{ id: 'plan-1', tipo: 'comercial', porcentaje: 25, base: 'utilidad_neta_venta', productos_alcanzados: JSON.stringify(['proyecto_personalizado']), mercados_alcanzados: JSON.stringify(['CL']), estado: 'activo', valid_until: null, valid_from: '2020-01-01', contexto_realizacion: null }],
    asignaciones_plan_comision: [{ id: 'asig-1', usuario_id: 1, plan_id: 'plan-1', valid_from: '2020-01-01', valid_until: null }],
  });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: { ...PROYECTO_HISTORICO_BASE, modoHistorico: 'reconstruccion' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comisiones.length, 0);
});

test('proyecto histórico: nunca se sincroniza con HubSpot aunque el body lo pida', async () => {
  const db = fakeDb();
  const response = await ventasHandler(fakeContext({
    method: 'POST', body: { ...PROYECTO_HISTORICO_BASE, hubspot: { fields: [{ name: 'x', value: 'y' }] } }, roleIdentity: admin(), db,
  }));
  assert.equal(response.status, 201);
  const body = (await response.json()).data;
  assert.equal(body.hubspotSync, null);
});

test('proyecto histórico: un vendedor común no puede registrarlo (decisión administrativa)', async () => {
  const db = fakeDb();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: PROYECTO_HISTORICO_BASE, roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 403);
});

test('proyecto histórico: modoHistorico inválido se rechaza', async () => {
  const db = fakeDb();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: { ...PROYECTO_HISTORICO_BASE, modoHistorico: 'inventado' }, roleIdentity: admin(), db }));
  assert.equal(response.status, 400);
});

// ── Cuarto bloque (03/09/2026): activación genera comisiones y finanzas de empresa reales ──

function seedProyectoActivable(overrides = {}) {
  return {
    ventas: [{ id: 'venta-1', producto: 'proyecto_personalizado', vendedor_email: 'admin@example.com', mercado: 'CL', moneda: 'CLP', precio_pactado: 1000000, distribucion_snapshot: null, modo_historico: null }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1' }],
    componentes: [{ id: 'comp-frontend', proyecto_id: 'proyecto-1', tipo: 'personalizado', precio_atribuido: 1000000 }],
    plantillas_distribucion: [{ id: 'pl-desarrollo', porcentaje_comercial: 25, porcentaje_supervision: 10, porcentaje_desarrollo: 45, porcentaje_empresa: 20, estado: 'activo' }],
    ...overrides,
  };
}

async function activarDistribucionCompleta(db, participaciones, ventaId = 'venta-1') {
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: ventaId } }));
  for (const p of participaciones) {
    await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', ...p }, roleIdentity: admin(), db, params: { id: ventaId } }));
  }
  return distribucionHandler(fakeContext({ body: { action: 'activar' }, roleIdentity: admin(), db, params: { id: ventaId } }));
}

const PARTICIPACIONES_COMPLETAS = [
  { concepto: 'comercial', beneficiarioEmail: 'comercial@example.com', porcentaje: 25 },
  { concepto: 'supervision', beneficiarioEmail: 'supervisor@example.com', porcentaje: 10 },
  { concepto: 'desarrollo', beneficiarioEmail: 'dev@example.com', porcentaje: 45 },
];

test('activación: genera una comisión independiente por cada participación personal resuelta', async () => {
  const db = fakeDb(seedProyectoActivable());
  const response = await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.comisionesGeneradas, 3);
  assert.equal(db._state.comisiones.length, 3);
  const comercial = db._state.comisiones.find((c) => c.tipo === 'comercial');
  assert.equal(comercial.beneficiario_email, 'comercial@example.com');
  assert.equal(comercial.monto_base, 1000000); // utilidad neta del proyecto (sin costos).
  assert.equal(comercial.monto_comision, 250000); // 25% de 1.000.000.
  assert.equal(comercial.moneda, 'CLP');
  assert.equal(comercial.distribucion_id, db._state.venta_distribuciones[0].id);
  assert.equal(comercial.participacion_id, db._state.venta_participaciones.find((p) => p.concepto === 'comercial').id);
});

test('activación: una persona con dos conceptos (vende y desarrolla) recibe dos filas separadas, nunca combinadas', async () => {
  const db = fakeDb(seedProyectoActivable());
  const participaciones = [
    { concepto: 'comercial', beneficiarioEmail: 'multi@example.com', porcentaje: 25 },
    { concepto: 'supervision', beneficiarioEmail: 'supervisor@example.com', porcentaje: 10 },
    { concepto: 'desarrollo', beneficiarioEmail: 'multi@example.com', porcentaje: 45 },
  ];
  await activarDistribucionCompleta(db, participaciones);
  const filasDeMulti = db._state.comisiones.filter((c) => c.beneficiario_email === 'multi@example.com');
  assert.equal(filasDeMulti.length, 2);
  assert.deepEqual(filasDeMulti.map((c) => c.tipo).sort(), ['comercial', 'desarrollo']);
});

test('activación: empresa nunca genera una comisión personal — se registra aparte, en proyecto_finanzas_empresa', async () => {
  const db = fakeDb(seedProyectoActivable());
  await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  assert.ok(!db._state.comisiones.some((c) => c.beneficiario_email === null || /empresa/i.test(c.beneficiario_email || '')));
  assert.equal(db._state.proyecto_finanzas_empresa.length, 1);
  const finanzas = db._state.proyecto_finanzas_empresa[0];
  assert.equal(finanzas.porcentaje_empresa, 20);
  assert.equal(finanzas.monto_bruto, 1000000);
  assert.equal(finanzas.utilidad_neta, 1000000);
  assert.equal(finanzas.monto_empresa, 200000); // 20% de la utilidad neta.
});

test('generarComisionesDesdeDistribucion: una participación "Pendiente de asignación" (sin beneficiario) nunca genera comisión', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const distribucionId = db._state.venta_distribuciones[0].id;
  db._state.venta_participaciones.push(
    { id: 'part-resuelta', distribucion_id: distribucionId, concepto: 'comercial', fase_id: null, beneficiario_email: 'a@example.com', porcentaje: 25 },
    { id: 'part-pendiente', distribucion_id: distribucionId, concepto: 'desarrollo', fase_id: null, beneficiario_email: null, porcentaje: 45 }
  );
  const ids = await generarComisionesDesdeDistribucion(db, 'req-test', { ventaId: 'venta-1', distribucionId, actorEmail: 'admin@example.com' });
  assert.equal(ids.length, 1);
  assert.equal(db._state.comisiones.length, 1);
  assert.equal(db._state.comisiones[0].beneficiario_email, 'a@example.com');
});

test('generarComisionesDesdeDistribucion: reintentar la generación nunca duplica comisiones (idempotente)', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const distribucionId = db._state.venta_distribuciones[0].id;
  db._state.venta_participaciones.push({ id: 'part-1', distribucion_id: distribucionId, concepto: 'comercial', fase_id: null, beneficiario_email: 'a@example.com', porcentaje: 25 });

  const primeraVez = await generarComisionesDesdeDistribucion(db, 'req-test', { ventaId: 'venta-1', distribucionId, actorEmail: 'admin@example.com' });
  const segundaVez = await generarComisionesDesdeDistribucion(db, 'req-test', { ventaId: 'venta-1', distribucionId, actorEmail: 'admin@example.com' });
  assert.equal(primeraVez.length, 1);
  assert.deepEqual(segundaVez, primeraVez); // devuelve los mismos ids, no crea nada nuevo.
  assert.equal(db._state.comisiones.length, 1);
});

test('activación: reintentar la activación (ya confirmada) es rechazada, nunca duplica comisiones', async () => {
  const db = fakeDb(seedProyectoActivable());
  await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  assert.equal(db._state.comisiones.length, 3);
  const reintento = await distribucionHandler(fakeContext({ body: { action: 'activar' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(reintento.status, 400);
  assert.equal(db._state.comisiones.length, 3); // sin cambios.
});

test('una plantilla modificada después de activar no altera los pools ya copiados a la distribución', async () => {
  const db = fakeDb(seedProyectoActivable());
  await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  db._state.plantillas_distribucion[0].porcentaje_desarrollo = 60; // Administración edita la plantilla después.
  const response = await distribucionHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const body = (await response.json()).data;
  assert.equal(body.distribucion.pools.desarrollo, 45); // nunca se recalcula desde la plantilla actual.
});

test('una distribución corregida conserva ambas versiones — las comisiones de la versión original nunca se tocan', async () => {
  const db = fakeDb(seedProyectoActivable());
  await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  const montoOriginal = db._state.comisiones.find((c) => c.tipo === 'comercial').monto_comision;

  const correccion = await distribucionHandler(fakeContext({ body: { action: 'corregir', motivo: 'Se reemplaza al desarrollador' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(correccion.status, 201);

  // La comisión generada con la versión 1 sigue exactamente igual.
  const comisionOriginal = db._state.comisiones.find((c) => c.tipo === 'comercial');
  assert.equal(comisionOriginal.monto_comision, montoOriginal);
  assert.equal(db._state.venta_distribuciones.filter((d) => d.estado === 'reemplazada').length, 1);
  assert.equal(db._state.venta_distribuciones.filter((d) => d.estado === 'borrador').length, 1);
});

test('costos pendientes (costos_cerrados=0): comisiones y finanzas de empresa quedan marcadas como estimación', async () => {
  const db = fakeDb(seedProyectoActivable());
  await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  assert.ok(db._state.comisiones.every((c) => c.es_estimacion === 1));
  assert.equal(db._state.proyecto_finanzas_empresa[0].es_estimacion, 1);
});

test('costos cerrados: comisiones y finanzas de empresa se generan como definitivas', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const distribucionId = db._state.venta_distribuciones[0].id;
  const cerrar = await distribucionHandler(fakeContext({ body: { action: 'cerrar-costos' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(cerrar.status, 200);
  for (const p of PARTICIPACIONES_COMPLETAS) {
    await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', ...p }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  }
  const activar = await distribucionHandler(fakeContext({ body: { action: 'activar' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(activar.status, 200);
  assert.ok(db._state.comisiones.every((c) => c.es_estimacion === 0));
  assert.equal(db._state.proyecto_finanzas_empresa[0].es_estimacion, 0);
  assert.equal(db._state.venta_distribuciones.find((d) => d.id === distribucionId).costos_cerrados, 1);
});

test('cerrar-costos dos veces se rechaza — no es una acción repetible en silencio', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  await distribucionHandler(fakeContext({ body: { action: 'cerrar-costos' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const segunda = await distribucionHandler(fakeContext({ body: { action: 'cerrar-costos' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(segunda.status, 400);
});

test('comisiones provisionales de un proyecto personalizado nunca pueden avanzar a pagable — bloqueadas hasta que Brenda confirme la política', async () => {
  const db = fakeDb(seedProyectoActivable());
  await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  const comision = db._state.comisiones[0];
  const resultado = await evaluateComisionGate(db, 'req-test', comision.id, 'admin@example.com');
  assert.equal(resultado.habilitada, false);
  assert.deepEqual(resultado.faltantes, ['politica_liberacion_pendiente_confirmacion']);
  assert.equal(db._state.comisiones.find((c) => c.id === comision.id).estado, 'calculada_provisional'); // nunca avanzó.
});

test('configurar-liberacion y configurar-plazo-resguardo guardan la estructura configurable sin habilitar pago automático', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const rLib = await distribucionHandler(fakeContext({
    body: { action: 'configurar-liberacion', politicaLiberacion: 'proporcional_por_pago', requiereHitoValidado: true },
    roleIdentity: admin(), db, params: { id: 'venta-1' },
  }));
  assert.equal(rLib.status, 200);
  const rPlazo = await distribucionHandler(fakeContext({
    body: { action: 'configurar-plazo-resguardo', activo: true, dias: 15, tipoDias: 'corridos', eventoInicio: 'pago_total', alcance: 'proyecto_completo' },
    roleIdentity: admin(), db, params: { id: 'venta-1' },
  }));
  assert.equal(rPlazo.status, 200);
  const d = db._state.venta_distribuciones[0];
  assert.equal(d.politica_liberacion, 'proporcional_por_pago');
  assert.equal(d.requiere_hito_validado, 1);
  assert.equal(d.plazo_resguardo_dias, 15);

  // Activar y confirmar que, pese a la configuración, el gate sigue bloqueado (no habilita pago automático).
  for (const p of PARTICIPACIONES_COMPLETAS) {
    await distribucionHandler(fakeContext({ body: { action: 'agregar-participacion', ...p }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  }
  await distribucionHandler(fakeContext({ body: { action: 'activar' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const resultado = await evaluateComisionGate(db, 'req-test', db._state.comisiones[0].id, 'admin@example.com');
  assert.equal(resultado.habilitada, false);
});

test('configurar-plazo-resguardo activo=true exige dias/tipoDias/eventoInicio/alcance', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const response = await distribucionHandler(fakeContext({ body: { action: 'configurar-plazo-resguardo', activo: true }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  assert.equal(response.status, 400);
});

test('la suma económica de una distribución activada sigue siendo exactamente 100% (pools + empresa)', async () => {
  const db = fakeDb(seedProyectoActivable());
  await activarDistribucionCompleta(db, PARTICIPACIONES_COMPLETAS);
  const sumaComisiones = db._state.comisiones.reduce((s, c) => s + c.porcentaje_snapshot, 0);
  const empresaPct = db._state.proyecto_finanzas_empresa[0].porcentaje_empresa;
  assert.equal(sumaComisiones + empresaPct, 100);
});

// ── Comisiones históricas (proyectos importados, RIO-119 cuarto bloque) ──

function seedVentaHistorica(overrides = {}) {
  return { ventas: [{ id: 'venta-hist', producto: 'proyecto_personalizado', modo_historico: 'reconstruccion' }], ...overrides };
}

test('comisiones-historicas: admin puede registrar una participación histórica pagada antes de la incorporación', async () => {
  const db = fakeDb(seedVentaHistorica());
  const response = await comisionesHistoricasHandler(fakeContext({
    body: { beneficiarioEmail: 'antiguo@example.com', concepto: 'desarrollo', importePagado: 500000, moneda: 'CLP', fechaAproximada: '2025-06', evidencia: 'Transferencia manual, sin comprobante digital', fuente: 'Declarado por Brenda de memoria' },
    roleIdentity: admin(), db, params: { id: 'venta-hist' },
  }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comisiones_historicas.length, 1);
  assert.equal(db._state.comisiones_historicas[0].estado, 'historica_pagada_antes_incorporacion');
  // Nunca toca la tabla real de comisiones — estructuralmente invisible para el calendario 10/25.
  assert.equal(db._state.comisiones.length, 0);
});

test('comisiones-historicas: exige fechaExacta o fechaAproximada (al menos una)', async () => {
  const db = fakeDb(seedVentaHistorica());
  const response = await comisionesHistoricasHandler(fakeContext({
    body: { beneficiarioEmail: 'antiguo@example.com', concepto: 'desarrollo', importePagado: 500000, moneda: 'CLP', fuente: 'x' },
    roleIdentity: admin(), db, params: { id: 'venta-hist' },
  }));
  assert.equal(response.status, 400);
});

test('comisiones-historicas: rechaza moneda o concepto inválido', async () => {
  const db = fakeDb(seedVentaHistorica());
  const r1 = await comisionesHistoricasHandler(fakeContext({
    body: { beneficiarioEmail: 'a@example.com', concepto: 'desarrollo', importePagado: 1000, moneda: 'USD', fechaExacta: '2025-01-01', fuente: 'x' },
    roleIdentity: admin(), db, params: { id: 'venta-hist' },
  }));
  assert.equal(r1.status, 400);
  const r2 = await comisionesHistoricasHandler(fakeContext({
    body: { beneficiarioEmail: 'a@example.com', concepto: 'inventado', importePagado: 1000, moneda: 'CLP', fechaExacta: '2025-01-01', fuente: 'x' },
    roleIdentity: admin(), db, params: { id: 'venta-hist' },
  }));
  assert.equal(r2.status, 400);
});

test('comisiones-historicas: solo aplica a ventas marcadas como importación histórica', async () => {
  const db = fakeDb(seedProyectoActivable());
  const response = await comisionesHistoricasHandler(fakeContext({
    body: { beneficiarioEmail: 'a@example.com', concepto: 'desarrollo', importePagado: 1000, moneda: 'CLP', fechaExacta: '2025-01-01', fuente: 'x' },
    roleIdentity: admin(), db, params: { id: 'venta-1' },
  }));
  assert.equal(response.status, 400);
});

test('comisiones-historicas: GET lista lo registrado', async () => {
  const db = fakeDb(seedVentaHistorica());
  await comisionesHistoricasHandler(fakeContext({
    body: { beneficiarioEmail: 'a@example.com', concepto: 'comercial', importePagado: 100000, moneda: 'CLP', fechaExacta: '2025-01-01', fuente: 'x' },
    roleIdentity: admin(), db, params: { id: 'venta-hist' },
  }));
  const response = await comisionesHistoricasHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { id: 'venta-hist' } }));
  const body = (await response.json()).data;
  assert.equal(body.comisionesHistoricas.length, 1);
});

// ── 403 para roles no administrativos (cuarto bloque) ──

test('distribucion: configurar-liberacion/configurar-plazo-resguardo/cerrar-costos son exclusivos de administración', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  for (const action of ['configurar-liberacion', 'configurar-plazo-resguardo', 'cerrar-costos', 'recalcular-finanzas-empresa']) {
    const response = await distribucionHandler(fakeContext({ body: { action }, roleIdentity: roleIdentity(), db, params: { id: 'venta-1' } }));
    assert.equal(response.status, 403, `action=${action}`);
  }
});

test('comisiones-historicas: un supervisor/vendedor/asistente no puede registrar ni ver comisiones históricas', async () => {
  const db = fakeDb(seedVentaHistorica());
  const supervisor = roleIdentity({ role: 'supervisor', permissions: PERMISSIONS.supervisor });
  const asistente = roleIdentity({ role: 'asistente', permissions: PERMISSIONS.asistente });
  for (const rol of [roleIdentity(), supervisor, asistente]) {
    const r1 = await comisionesHistoricasHandler(fakeContext({ method: 'GET', roleIdentity: rol, db, params: { id: 'venta-hist' } }));
    assert.equal(r1.status, 403);
    const r2 = await comisionesHistoricasHandler(fakeContext({
      body: { beneficiarioEmail: 'a@example.com', concepto: 'comercial', importePagado: 1000, moneda: 'CLP', fechaExacta: '2025-01-01', fuente: 'x' },
      roleIdentity: rol, db, params: { id: 'venta-hist' },
    }));
    assert.equal(r2.status, 403);
  }
});

test('manipulación: un id de venta inexistente en comisiones-historicas devuelve 404, nunca filtra datos de otra venta', async () => {
  const db = fakeDb(seedVentaHistorica());
  const response = await comisionesHistoricasHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { id: 'no-existe' } }));
  assert.equal(response.status, 404);
});

test('manipulación: un porcentaje fuera de rango en agregar-participacion se rechaza server-side, aunque el cliente lo permita', async () => {
  const db = fakeDb(seedProyectoActivable());
  await distribucionHandler(fakeContext({ body: { action: 'definir-pools', plantillaId: 'pl-desarrollo' }, roleIdentity: admin(), db, params: { id: 'venta-1' } }));
  const response = await distribucionHandler(fakeContext({
    body: { action: 'agregar-participacion', concepto: 'comercial', beneficiarioEmail: 'a@example.com', porcentaje: 101 },
    roleIdentity: admin(), db, params: { id: 'venta-1' },
  }));
  assert.equal(response.status, 400);
});
