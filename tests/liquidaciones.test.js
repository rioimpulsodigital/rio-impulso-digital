// Pruebas de functions/_shared/liquidaciones.js — RIO-115.
// Cubre los criterios de aceptación: CLP y ARS nunca se suman sin
// conversión documentada, y el total transferido siempre reconcilia con
// las comisiones incluidas. Reutiliza marcarComisionPagada de RIO-114 sin
// duplicar su lógica de estados.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrarConversion, registrarLiquidacion, obtenerLiquidacion, LiquidacionError } from '../functions/_shared/liquidaciones.js';
import { ComisionError } from '../functions/_shared/comisiones.js';

function fakeDb() {
  const state = {
    comisiones: [], conversiones: [], transferencias_comision: [], transferencia_detalle: [], eventos_historial: [],
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
    if (sql.startsWith('SELECT * FROM comisiones WHERE id')) return state.comisiones.filter((c) => c.id === p[0]);
    if (sql.startsWith('SELECT id FROM conversiones WHERE comision_id')) return state.conversiones.filter((c) => c.comision_id === p[0]);
    if (sql.startsWith('SELECT * FROM conversiones WHERE comision_id')) return state.conversiones.filter((c) => c.comision_id === p[0]);
    if (sql.startsWith('SELECT id FROM transferencia_detalle WHERE comision_id')) return state.transferencia_detalle.filter((d) => d.comision_id === p[0]);
    if (sql.startsWith('SELECT * FROM transferencias_comision WHERE id')) return state.transferencias_comision.filter((t) => t.id === p[0]);
    if (sql.startsWith('SELECT * FROM transferencia_detalle WHERE transferencia_id')) return state.transferencia_detalle.filter((d) => d.transferencia_id === p[0]);
    throw new Error('consulta inesperada en test: ' + sql);
  }

  function runMutation(sql, p) {
    if (sql.startsWith('INSERT INTO conversiones')) {
      state.conversiones.push({ id: p[0], comision_id: p[1], monto_original: p[2], fecha_conversion: p[3], tipo_cambio_mostrado: p[4], costos_o_diferencias_informadas: p[5], monto_convertido: p[6], registrado_por: p[7] });
    } else if (sql.startsWith('INSERT INTO transferencias_comision')) {
      state.transferencias_comision.push({ id: p[0], beneficiario_email: p[1], fecha: p[2], moneda_final: p[3], monto_total_transferido: p[4], comprobante_nota: p[5], registrado_por: p[6] });
    } else if (sql.startsWith('INSERT INTO transferencia_detalle')) {
      state.transferencia_detalle.push({ id: p[0], transferencia_id: p[1], comision_id: p[2], monto_incluido: p[3], moneda_original: p[4], conversion_id: p[5] });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_nuevo: p[5] });
    } else if (sql.startsWith("UPDATE comisiones SET estado = 'pagada'")) {
      const c = state.comisiones.find((x) => x.id === p[1]);
      if (c) { c.estado = 'pagada'; c.fecha_pago_real = p[0]; }
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }

  return { _state: state, prepare: (sql) => makeStatement(sql) };
}

function seedComision(db, overrides = {}) {
  const c = { id: `com-${db._state.comisiones.length + 1}`, tipo: 'comercial', venta_id: 'v1', beneficiario_email: 'vendedor@example.com', moneda: 'CLP', monto_comision: 20000, estado: 'programada', ...overrides };
  db._state.comisiones.push(c);
  return c;
}

// --- registrarConversion() ---

test('registrarConversion() — rechaza convertir una comisión que ya está en CLP', async () => {
  const db = fakeDb();
  const c = seedComision(db, { moneda: 'CLP' });
  await assert.rejects(
    () => registrarConversion(db, 'req-1', { comisionId: c.id, montoOriginal: 20000, tipoCambioMostrado: 1, montoConvertido: 20000, registradoPor: 'admin@example.com' }),
    (e) => { assert.ok(e instanceof LiquidacionError); assert.equal(e.code, 'conversion_no_aplica'); return true; }
  );
});

test('registrarConversion() — registra una conversión ARS -> CLP con el tipo de cambio informado, tal cual, sin recalcularlo', async () => {
  const db = fakeDb();
  const c = seedComision(db, { moneda: 'ARS', monto_comision: 18000 });
  const id = await registrarConversion(db, 'req-2', {
    comisionId: c.id, montoOriginal: 18000, tipoCambioMostrado: 0.606, costosODiferencias: 0, montoConvertido: 10908, registradoPor: 'admin@example.com',
  });
  assert.ok(id);
  const conv = db._state.conversiones[0];
  assert.equal(conv.monto_original, 18000);
  assert.equal(conv.monto_convertido, 10908);
  assert.equal(conv.tipo_cambio_mostrado, 0.606);
});

test('registrarConversion() — rechaza convertir la misma comisión dos veces', async () => {
  const db = fakeDb();
  const c = seedComision(db, { moneda: 'ARS' });
  await registrarConversion(db, 'req-3a', { comisionId: c.id, montoOriginal: 18000, tipoCambioMostrado: 0.6, montoConvertido: 10800, registradoPor: 'admin@example.com' });
  await assert.rejects(
    () => registrarConversion(db, 'req-3b', { comisionId: c.id, montoOriginal: 18000, tipoCambioMostrado: 0.61, montoConvertido: 10980, registradoPor: 'admin@example.com' }),
    (e) => { assert.equal(e.code, 'ya_convertida'); return true; }
  );
});

// --- registrarLiquidacion(): reconciliación y no mezclar monedas sin conversión ---

test('registrarLiquidacion() — rechaza incluir una comisión en ARS dentro de una liquidación en CLP sin conversión registrada', async () => {
  const db = fakeDb();
  const c = seedComision(db, { moneda: 'ARS', monto_comision: 18000 });
  await assert.rejects(
    () => registrarLiquidacion(db, 'req-4', {
      beneficiarioEmail: 'vendedor@example.com', fecha: '2026-09-25', monedaFinal: 'CLP', comisionIds: [c.id], montoTotalTransferido: 10908, actorEmail: 'admin@example.com',
    }),
    (e) => { assert.ok(e instanceof LiquidacionError); assert.equal(e.code, 'conversion_faltante'); return true; }
  );
});

test('registrarLiquidacion() — rechaza si el total declarado no reconcilia con la suma de las comisiones incluidas', async () => {
  const db = fakeDb();
  const c1 = seedComision(db, { moneda: 'CLP', monto_comision: 12000 });
  const c2 = seedComision(db, { moneda: 'CLP', monto_comision: 9500 });
  await assert.rejects(
    () => registrarLiquidacion(db, 'req-5', {
      beneficiarioEmail: 'vendedor@example.com', fecha: '2026-09-25', monedaFinal: 'CLP', comisionIds: [c1.id, c2.id], montoTotalTransferido: 99999, actorEmail: 'admin@example.com',
    }),
    (e) => { assert.equal(e.code, 'no_reconciliable'); return true; }
  );
});

test('registrarLiquidacion() — rechaza mezclar comisiones de dos personas distintas en una misma liquidación', async () => {
  const db = fakeDb();
  const c1 = seedComision(db, { beneficiario_email: 'a@example.com', monto_comision: 10000 });
  const c2 = seedComision(db, { beneficiario_email: 'b@example.com', monto_comision: 10000 });
  await assert.rejects(
    () => registrarLiquidacion(db, 'req-6', {
      beneficiarioEmail: 'a@example.com', fecha: '2026-09-25', monedaFinal: 'CLP', comisionIds: [c1.id, c2.id], montoTotalTransferido: 20000, actorEmail: 'admin@example.com',
    }),
    (e) => { assert.equal(e.code, 'beneficiario_no_coincide'); return true; }
  );
});

test('registrarLiquidacion() — rechaza una comisión que no está programada todavía', async () => {
  const db = fakeDb();
  const c = seedComision(db, { estado: 'habilitada' });
  await assert.rejects(
    () => registrarLiquidacion(db, 'req-7', {
      beneficiarioEmail: 'vendedor@example.com', fecha: '2026-09-25', monedaFinal: 'CLP', comisionIds: [c.id], montoTotalTransferido: 20000, actorEmail: 'admin@example.com',
    }),
    (e) => { assert.equal(e.code, 'transicion_invalida'); return true; }
  );
});

test('registrarLiquidacion() — no se puede volver a liquidar una comisión ya pagada (queda "no programada" en cuanto se paga la primera vez)', async () => {
  const db = fakeDb();
  const c = seedComision(db, { monto_comision: 20000 });
  await registrarLiquidacion(db, 'req-8a', { beneficiarioEmail: 'vendedor@example.com', fecha: '2026-09-25', monedaFinal: 'CLP', comisionIds: [c.id], montoTotalTransferido: 20000, actorEmail: 'admin@example.com' });
  assert.equal(c.estado, 'pagada');
  await assert.rejects(
    () => registrarLiquidacion(db, 'req-8b', { beneficiarioEmail: 'vendedor@example.com', fecha: '2026-09-26', monedaFinal: 'CLP', comisionIds: [c.id], montoTotalTransferido: 20000, actorEmail: 'admin@example.com' }),
    (e) => { assert.ok(e instanceof LiquidacionError); assert.equal(e.code, 'transicion_invalida'); return true; }
  );
});

test('registrarLiquidacion() — la comprobación de "ya liquidada" (transferencia_detalle) es una segunda barrera defensiva, independiente del estado de la comisión', async () => {
  const db = fakeDb();
  const c = seedComision(db, { monto_comision: 20000 });
  // Simula una comisión que por algún motivo sigue en 'programada' pero ya tiene un detalle de transferencia (estado inconsistente que no debería ocurrir en el flujo normal).
  db._state.transferencia_detalle.push({ id: 'det-x', transferencia_id: 'otra-transferencia', comision_id: c.id, monto_incluido: 20000, moneda_original: 'CLP', conversion_id: null });
  await assert.rejects(
    () => registrarLiquidacion(db, 'req-8c', { beneficiarioEmail: 'vendedor@example.com', fecha: '2026-09-26', monedaFinal: 'CLP', comisionIds: [c.id], montoTotalTransferido: 20000, actorEmail: 'admin@example.com' }),
    (e) => { assert.equal(e.code, 'ya_liquidada'); return true; }
  );
});

// --- Escenario real de RIO-97 v2 sección 17: liquidación de Alberto con CLP + ARS convertido ---

test('registrarLiquidacion() — agrupa comisiones de CLP y ARS-convertido en una sola transferencia, tal como el ejemplo de RIO-97 v2', async () => {
  const db = fakeDb();
  const c1 = seedComision(db, { beneficiario_email: 'alberto@example.com', moneda: 'CLP', monto_comision: 12000 });
  const c2 = seedComision(db, { beneficiario_email: 'alberto@example.com', moneda: 'CLP', monto_comision: 9500 });
  const c3 = seedComision(db, { beneficiario_email: 'alberto@example.com', moneda: 'ARS', monto_comision: 18000 });
  await registrarConversion(db, 'req-9a', { comisionId: c3.id, montoOriginal: 18000, tipoCambioMostrado: 0.606, montoConvertido: 10908, registradoPor: 'admin@example.com' });

  const id = await registrarLiquidacion(db, 'req-9b', {
    beneficiarioEmail: 'alberto@example.com', fecha: '2026-09-25', monedaFinal: 'CLP',
    comisionIds: [c1.id, c2.id, c3.id], montoTotalTransferido: 12000 + 9500 + 10908, actorEmail: 'admin@example.com',
  });
  assert.ok(id);
  assert.equal(db._state.comisiones.find((c) => c.id === c1.id).estado, 'pagada');
  assert.equal(db._state.comisiones.find((c) => c.id === c2.id).estado, 'pagada');
  assert.equal(db._state.comisiones.find((c) => c.id === c3.id).estado, 'pagada', 'la comisión en ARS también queda pagada, aunque el monto transferido fue en CLP');

  const resultado = await obtenerLiquidacion(db, 'req-9c', id);
  const suma = resultado.detalle.reduce((s, d) => s + d.monto_incluido, 0);
  assert.equal(suma, 32408, 'la suma del detalle reconcilia exactamente con el total transferido');
  assert.equal(resultado.transferencia.monto_total_transferido, suma);
  assert.equal(resultado.detalle.find((d) => d.comision_id === c3.id).conversion_id, db._state.conversiones[0].id, 'la fila ARS queda vinculada a su conversión concreta');
});

test('obtenerLiquidacion() — devuelve null para una liquidación inexistente', async () => {
  const db = fakeDb();
  const resultado = await obtenerLiquidacion(db, 'req-10', 'no-existe');
  assert.equal(resultado, null);
});
