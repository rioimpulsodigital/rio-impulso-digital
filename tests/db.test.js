// Pruebas de functions/_shared/db.js — RIO-110 sección 12 (D1).
// Usa un binding D1 simulado en memoria (sin Cloudflare real) para probar el
// contrato de la capa de acceso: parametrización, manejo de errores,
// batch/transacción y la comprobación de conectividad usada por /health.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, execute, transaction, checkConnectivity, DbError } from '../functions/_shared/db.js';

function fakeDb({ onAll, onRun, onFirst, onBatch } = {}) {
  return {
    prepare(sql) {
      const boundParams = [];
      return {
        bind(...params) {
          boundParams.push(...params);
          return this;
        },
        all: async () => {
          if (onAll) return onAll(sql, boundParams);
          return { results: [] };
        },
        run: async () => {
          if (onRun) return onRun(sql, boundParams);
          return { success: true };
        },
        first: async () => {
          if (onFirst) return onFirst(sql, boundParams);
          return null;
        },
      };
    },
    batch: async (statements) => {
      if (onBatch) return onBatch(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

test('query() pasa los parámetros vía bind(), nunca concatenados en el SQL', async () => {
  let capturedSql, capturedParams;
  const db = fakeDb({
    onAll: (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { results: [{ id: 1 }] };
    },
  });
  const rows = await query(db, 'req-1', 'SELECT * FROM _system_health WHERE id = ?', [42]);
  assert.equal(capturedSql, 'SELECT * FROM _system_health WHERE id = ?');
  assert.deepEqual(capturedParams, [42]);
  assert.deepEqual(rows, [{ id: 1 }]);
});

test('query() sin resultados devuelve array vacío, no null/undefined', async () => {
  const db = fakeDb({ onAll: () => ({ results: undefined }) });
  const rows = await query(db, 'req-2', 'SELECT 1');
  assert.deepEqual(rows, []);
});

test('query() traduce un fallo del driver a DbError genérico', async () => {
  const db = fakeDb({
    onAll: () => {
      throw new Error('mensaje interno del driver con detalle de SQL');
    },
  });
  await assert.rejects(() => query(db, 'req-3', 'SELECT * FROM x'), (e) => {
    assert.ok(e instanceof DbError);
    assert.equal(e.reason, 'query_failed');
    // El error público nunca debe filtrar el mensaje crudo del driver.
    assert.notEqual(e.message, 'mensaje interno del driver con detalle de SQL');
    return true;
  });
});

test('execute() ejecuta una sola sentencia parametrizada', async () => {
  let capturedParams;
  const db = fakeDb({ onRun: (sql, params) => { capturedParams = params; return { success: true, meta: { changes: 1 } }; } });
  const result = await execute(db, 'req-4', 'INSERT INTO _system_health (note) VALUES (?)', ['ok']);
  assert.deepEqual(capturedParams, ['ok']);
  assert.equal(result.success, true);
});

test('transaction() delega en batch() y devuelve sus resultados', async () => {
  const db = fakeDb({ onBatch: (statements) => statements.map((_, i) => ({ success: true, index: i })) });
  const stmts = [db.prepare('a'), db.prepare('b')];
  const results = await transaction(db, 'req-5', stmts);
  assert.equal(results.length, 2);
});

test('transaction() traduce un fallo de batch() a DbError genérico', async () => {
  const db = fakeDb({ onBatch: () => { throw new Error('detalle interno'); } });
  await assert.rejects(() => transaction(db, 'req-6', []), (e) => {
    assert.ok(e instanceof DbError);
    assert.equal(e.reason, 'transaction_failed');
    return true;
  });
});

test('checkConnectivity() true cuando D1 responde correctamente', async () => {
  const db = fakeDb({ onFirst: () => ({ ok: 1 }) });
  assert.equal(await checkConnectivity(db, 'req-7'), true);
});

test('checkConnectivity() false (no lanza) cuando D1 falla', async () => {
  const db = fakeDb({
    onFirst: () => {
      throw new Error('D1 no disponible');
    },
  });
  assert.equal(await checkConnectivity(db, 'req-8'), false);
});
