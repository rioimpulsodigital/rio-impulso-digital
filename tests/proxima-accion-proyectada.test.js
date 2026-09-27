// Pruebas de "Próxima acción" — RIO-123 (27/09/2026), hallazgo de la venta
// controlada V-20260927-7CF244 en Producción: después de la aprobación final
// del cliente, la ficha seguía mostrando "Esperar aprobación del cliente (o
// corregir si pide cambios)" — un paso ya cumplido — porque GET
// /ventas/:id exponía la `proxima_accion` MÁS RECIENTE de todo el historial
// de la venta, y aprobarComponente() (entre otras transiciones) nunca
// escribe una nueva, así que la anterior quedaba visible para siempre.
//
// La corrección reemplaza esa lectura histórica por una PROYECCIÓN del
// estado vigente (calcularProximaAccionProyecto, functions/_shared/proyectos.js),
// derivada exclusivamente de hechos actuales — nunca del último evento
// escrito. El historial de eventos (GET /ventas/:id/historial) no se toca:
// sigue mostrando "Esperar aprobación del cliente" como evidencia de lo que
// correspondía en ese momento.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularProximaAccionProyecto } from '../functions/_shared/proyectos.js';
import { onRequest as ventaHandler } from '../functions/interno/api/ventas/[id].js';

// ── calcularProximaAccionProyecto() — función pura ──────────────────────

function componente(overrides = {}) {
  return { id: 'comp-1', tipo: 'generico', estado_actual: 'pendiente', ...overrides };
}

test('caso 1 — componente "entregada": la próxima acción es esperar aprobación del cliente', () => {
  const resultado = calcularProximaAccionProyecto([componente({ estado_actual: 'entregada' })], 'en_espera_aprobacion', new Set());
  assert.equal(resultado, 'Esperar aprobación del cliente (o corregir si pide cambios)');
});

test('caso 2 — componente "aprobada" + comisiones reales todavía sin pagar (estadoOperativo pendiente_cierre): NUNCA la acción histórica de "entregada"', () => {
  const resultado = calcularProximaAccionProyecto([componente({ estado_actual: 'aprobada' })], 'pendiente_cierre', new Set());
  assert.equal(resultado, 'Pendiente de cierre y liquidación de comisiones');
  assert.notEqual(resultado, 'Esperar aprobación del cliente (o corregir si pide cambios)');
});

test('caso 3 — componente "aprobada" + todas las comisiones reales pagadas (estadoOperativo completado): vacía, nunca una acción antigua', () => {
  const resultado = calcularProximaAccionProyecto([componente({ estado_actual: 'aprobada' })], 'completado', new Set());
  assert.equal(resultado, null);
});

test('caso 4 — el cliente pidió corrección (el componente vuelve a "en_produccion" tras haber pasado por "entregada"): corregir y volver a entregar', () => {
  const resultado = calcularProximaAccionProyecto(
    [componente({ estado_actual: 'en_produccion' })],
    'en_produccion',
    new Set(['comp-1']) // ya existe un evento histórico de ESTE componente que pasó por 'entregada'.
  );
  assert.equal(resultado, 'Corregir y volver a entregar');
});

test('un componente recién en producción, que NUNCA pasó por "entregada", no muestra el texto de corrección (no es una corrección)', () => {
  const resultado = calcularProximaAccionProyecto([componente({ estado_actual: 'en_produccion' })], 'en_produccion', new Set());
  assert.notEqual(resultado, 'Corregir y volver a entregar');
  assert.equal(resultado, null, 'sin una acción más específica que la que ya muestra el propio estado del componente');
});

test('caso 5 — pago acreditado nunca produce un texto de "esperar pago", en ningún estado operativo', () => {
  for (const estadoOperativo of ['registrado', 'en_produccion', 'en_espera_aprobacion', 'pendiente_cierre', 'completado', 'cancelada', 'en_espera_pago', null]) {
    const resultado = calcularProximaAccionProyecto([componente({ estado_actual: 'entregada' })], estadoOperativo, new Set());
    assert.ok(!/esperar pago|pago del cliente/i.test(resultado || ''), `estadoOperativo=${estadoOperativo}: "${resultado}"`);
  }
});

test('venta cancelada: sin próxima acción, nunca un paso operativo obsoleto', () => {
  assert.equal(calcularProximaAccionProyecto([componente({ estado_actual: 'entregada' })], 'cancelada', new Set()), null);
});

test('pack (2 componentes): la próxima acción sigue al PRIMER componente todavía no aprobado, en el orden real de producción', () => {
  const ficha = componente({ id: 'ficha', tipo: 'ficha', estado_actual: 'aprobada' });
  const landing = componente({ id: 'landing', tipo: 'generico', estado_actual: 'entregada' });
  const resultado = calcularProximaAccionProyecto([ficha, landing], 'en_espera_aprobacion', new Set());
  assert.equal(resultado, 'Esperar aprobación del cliente (o corregir si pide cambios)', 'debe seguir a la Landing, que es la que realmente sigue pendiente');
});

test('pack: mientras la Ficha (primera en orden) sigue bloqueada/pendiente, no se adelanta ninguna acción de la Landing', () => {
  const ficha = componente({ id: 'ficha', tipo: 'ficha', estado_actual: 'en_produccion' });
  const landing = componente({ id: 'landing', tipo: 'generico', estado_actual: 'bloqueada' });
  const resultado = calcularProximaAccionProyecto([ficha, landing], 'en_produccion', new Set());
  assert.equal(resultado, null);
});

// ── GET /ventas/:id — integración end-to-end, reproduce la venta real ────

function fakeDb(state) {
  function bind() { return this; }
  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
    };
  }
  function runSelect(sql, p) {
    if (sql.includes('FROM ventas v JOIN clientes c')) {
      // Mismas columnas exactas que alias el SELECT real — nunca se
      // spreadea el cliente entero (pisaría venta.id con cliente.id).
      return state.ventas.filter((v) => v.id === p[0]).map((v) => {
        const c = state.clientes.find((x) => x.id === v.cliente_id) || {};
        return { ...v, negocio: c.negocio, contacto_nombre: c.contacto_nombre, telefono: c.telefono, cliente_email: c.email, datos_facturacion_ar: c.datos_facturacion_ar };
      });
    }
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) return state.componentes.filter((c) => c.proyecto_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((pg) => pg.venta_id === p[0]);
    if (sql.startsWith("SELECT DISTINCT entidad_id FROM eventos_historial WHERE entidad = 'pago'")) return [];
    if (sql.startsWith("SELECT COUNT(*) AS total FROM incidencias")) return [{ total: 0 }];
    if (sql.startsWith("SELECT DISTINCT entidad_id FROM eventos_historial WHERE entidad = 'componente' AND estado_nuevo = 'entregada'")) {
      const consultados = new Set(p);
      return [...new Set(state.eventos_historial.filter((e) => e.entidad === 'componente' && e.estado_nuevo === 'entregada' && consultados.has(e.entidad_id)).map((e) => e.entidad_id))]
        .map((entidad_id) => ({ entidad_id }));
    }
    if (sql.includes('FROM materiales_informados_detalle')) return [];
    if (sql.startsWith('SELECT * FROM materiales_confirmaciones')) return [];
    if (sql.startsWith("SELECT monto, nota FROM costos_directos")) return [];
    throw new Error('consulta inesperada en test: ' + sql);
  }
  return { prepare: (sql) => makeStatement(sql) };
}

function ventaBase() {
  return {
    id: 'venta-1', codigo_venta: 'V-20260927-7CF244', cliente_id: 'cliente-1', mercado: 'CL', producto: 'generico',
    moneda: 'CLP', tipo_precio: 'lanzamiento', precio_pactado: 120000, vendedor_email: 'vendedor@example.com',
    estado_actual: 'registrada', created_at: '2026-09-27 10:00:00', tipo_venta: 'equipo', equipo_id: null,
    supervisor_snapshot_email: null, plan_supervision_snapshot_id: null, supervision_aplica: 0, motivo_sin_supervision: null,
    porcentaje_supervision_aplicado: 0, porcentaje_final_empresa: 20, nombre_proyecto: null, descripcion_proyecto: null,
    notion_url: null, distribucion_snapshot: null, modo_historico: null, antecedentes_kit_json: null,
  };
}

function fakeContext(db) {
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas/venta-1'),
    env: { DB: db }, params: { id: 'venta-1' },
    data: { requestId: 'req-proxima-accion-test', roleIdentity: { email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: { viewOthersData: true } } },
  };
}

test('GET /ventas/:id — venta equivalente a V-20260927-7CF244: "entregada" muestra esperar aprobación; tras aprobar, deja de mostrarla y refleja pendiente_cierre', async () => {
  const state = {
    ventas: [ventaBase()],
    clientes: [{ id: 'cliente-1', negocio: 'Negocio Test 27-9', contacto_nombre: 'Cliente Prueba', telefono: null, email: null, datos_facturacion_ar: null }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1', codigo_proyecto: 'P-1', estado_actual: 'en_espera_aprobacion' }],
    componentes: [{ id: 'comp-1', proyecto_id: 'proyecto-1', tipo: 'generico', estado_actual: 'entregada', materiales_estado: 'completos', precio_individual_referencia: 120000, precio_atribuido: 120000, orden: null }],
    pagos_esperados: [{ id: 'pago-1', venta_id: 'venta-1', tipo: 'total', monto: 120000, moneda: 'CLP', estado: 'acreditado' }],
    eventos_historial: [
      { entidad: 'componente', entidad_id: 'comp-1', estado_nuevo: 'en_produccion' },
      { entidad: 'componente', entidad_id: 'comp-1', estado_nuevo: 'entregada' },
    ],
  };

  const antes = await (await ventaHandler(fakeContext(fakeDb(state)))).json();
  assert.equal(antes.data.venta.estadoOperativo, 'en_espera_aprobacion');
  assert.equal(antes.data.venta.proximaAccion, 'Esperar aprobación del cliente (o corregir si pide cambios)');

  // El cliente aprueba: el componente pasa a 'aprobada' y el proyecto (ya
  // recalculado por recomputeProyectoEstado, sin cambios en esta corrección)
  // a 'pendiente_cierre' — la comisión real de esta venta sigue sin pagar.
  // El evento de aprobación NUNCA escribe una proxima_accion nueva (mismo
  // comportamiento real de aprobarComponente()) — es exactamente el hueco
  // que producía el hallazgo.
  state.componentes[0].estado_actual = 'aprobada';
  state.proyectos[0].estado_actual = 'pendiente_cierre';
  state.eventos_historial.push({ entidad: 'componente', entidad_id: 'comp-1', estado_nuevo: 'aprobada' });

  const despues = await (await ventaHandler(fakeContext(fakeDb(state)))).json();
  assert.equal(despues.data.venta.estadoOperativo, 'pendiente_cierre');
  assert.equal(despues.data.venta.proximaAccion, 'Pendiente de cierre y liquidación de comisiones');
  assert.notEqual(despues.data.venta.proximaAccion, 'Esperar aprobación del cliente (o corregir si pide cambios)', 'el hallazgo real: ya no debe quedar la acción cumplida');
  assert.equal(despues.data.venta.responsableProximaAccion, null);
});

test('GET /ventas/:id — una vez pagada la comisión real (proyecto completado), la ficha ya no muestra ninguna próxima acción', async () => {
  const state = {
    ventas: [ventaBase()],
    clientes: [{ id: 'cliente-1', negocio: 'Negocio Test 27-9', contacto_nombre: null, telefono: null, email: null, datos_facturacion_ar: null }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1', codigo_proyecto: 'P-1', estado_actual: 'completado' }],
    componentes: [{ id: 'comp-1', proyecto_id: 'proyecto-1', tipo: 'generico', estado_actual: 'aprobada', materiales_estado: 'completos', precio_individual_referencia: 120000, precio_atribuido: 120000, orden: null }],
    pagos_esperados: [{ id: 'pago-1', venta_id: 'venta-1', tipo: 'total', monto: 120000, moneda: 'CLP', estado: 'acreditado' }],
    eventos_historial: [{ entidad: 'componente', entidad_id: 'comp-1', estado_nuevo: 'aprobada' }],
  };
  const r = await (await ventaHandler(fakeContext(fakeDb(state)))).json();
  assert.equal(r.data.venta.estadoOperativo, 'completado');
  assert.equal(r.data.venta.proximaAccion, null);
});
