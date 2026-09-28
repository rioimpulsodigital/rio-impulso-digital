// Protección de la separación Preview / Production del Worker de
// reevaluación de comisiones — RIO-123 (28/09/2026). Mismo criterio y mismo
// método (lectura de texto, sin parser TOML) que
// tests/wrangler-config.test.js: los bindings de Wrangler no se heredan
// entre entornos con nombre, así que Production necesita su propia sección
// completa. Estas pruebas fallan si Production llegara a referenciar, aunque
// sea por un valor copiado y pegado, cualquier recurso de Preview.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML = fs.readFileSync(path.join(ROOT, 'workers/comisiones-cron/wrangler.toml'), 'utf8');

const PREVIEW_WORKER_NAME = 'rio-comisiones-cron-preview';
const PREVIEW_DB_NAME = 'rio-ventas-preview';
const PREVIEW_DB_ID = '1aed8e43-6e47-40c9-9770-1c50f6586d20';
const PROD_WORKER_NAME = 'rio-comisiones-cron';
const PROD_DB_NAME = 'rio-ventas-prod';
const PROD_DB_ID = '11132d3b-4016-482f-a7b5-24c026d89ffa';

function secciones() {
  const out = [{ header: '', lines: [] }];
  for (const raw of TOML.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (m) out.push({ header: m[1].trim(), lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}
function textoActivo(filtro) {
  return secciones().filter((s) => filtro(s.header)).map((s) => [s.header, ...s.lines].join('\n')).join('\n');
}
const esProduccion = (h) => h === 'env.production' || h.startsWith('env.production.');
const esNivelSuperior = (h) => !h.startsWith('env.');

test('nivel superior (Preview, sin --env): mismo Worker e igual D1 que siempre — rio-comisiones-cron-preview / rio-ventas-preview', () => {
  const t = textoActivo(esNivelSuperior);
  assert.ok(t.includes(`name = "${PREVIEW_WORKER_NAME}"`));
  assert.ok(t.includes(`database_name = "${PREVIEW_DB_NAME}"`));
  assert.ok(t.includes(`database_id = "${PREVIEW_DB_ID}"`));
  assert.match(t, /binding = "DB"/);
  assert.ok(!/-prod\b/.test(t), 'Preview nunca referencia recursos de Production');
});

test('env.production: Worker y D1 propios de Production — rio-comisiones-cron / rio-ventas-prod, con su database_id real', () => {
  const t = textoActivo(esProduccion);
  assert.ok(t.includes('env.production'), 'debe existir la sección explícita de Production');
  assert.ok(t.includes(`name = "${PROD_WORKER_NAME}"`), 'Production debe declarar su propio nombre de Worker, nunca el de Preview');
  assert.ok(t.includes(`database_name = "${PROD_DB_NAME}"`));
  assert.ok(t.includes(`database_id = "${PROD_DB_ID}"`));
  assert.match(t, /binding = "DB"/);
  assert.ok(!t.includes(PREVIEW_DB_NAME), 'Production no puede usar la base de Preview');
  assert.ok(!t.includes(PREVIEW_DB_ID), 'Production no puede usar el database_id de Preview');
  assert.ok(!t.includes(PREVIEW_WORKER_NAME), 'Production no puede reapuntar el Worker de Preview');
});

test('Production declara su propio cron trigger explícito (no depende de heredar el de nivel superior)', () => {
  const t = textoActivo(esProduccion);
  assert.match(t, /crons = \[.*\]/, 'debe declarar su propio [triggers] con el/los cron(s)');
});

test('nunca queda un placeholder ni un ID inventado activo, en ninguno de los dos entornos', () => {
  const activo = secciones().map((s) => [s.header, ...s.lines].join('\n')).join('\n');
  assert.ok(!/<COMPLETAR>|PENDIENTE_|TODO_ID/i.test(activo));
});

test('el valor de ningún secreto (MANUAL_TRIGGER_SECRET) está commiteado en este archivo — solo el nombre, en un comentario', () => {
  assert.ok(!/^\s*MANUAL_TRIGGER_SECRET\s*=/m.test(TOML), 'el secreto nunca se asigna un valor en wrangler.toml');
  assert.ok(TOML.includes('MANUAL_TRIGGER_SECRET'), 'el nombre del secreto sigue documentado para quien lo cargue');
});
