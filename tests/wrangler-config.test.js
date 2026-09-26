// Protección de la separación Preview / Producción de wrangler.toml —
// RIO-123 (26/09/2026).
//
// Por qué existe: con `pages_build_output_dir`, wrangler.toml es la fuente de
// verdad de los bindings de Pages, y los bindings NO se heredan por entorno
// pero SÍ se aplican a ambos si están a nivel superior. Con el D1/R2 de
// Preview a nivel superior, fusionar a `main` habría conectado Producción a
// `rio-ventas-preview` y `rio-comprobantes-preview` (escribiendo datos reales
// en la base de Preview). Estas pruebas leen el archivo como texto (sin
// parser TOML: el formato usado es simple) y fallan si esa mezcla vuelve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');

const PREVIEW_DB_NAME = 'rio-ventas-preview';
const PREVIEW_DB_ID = '1aed8e43-6e47-40c9-9770-1c50f6586d20';
const PREVIEW_BUCKET = 'rio-comprobantes-preview';
const PROD_DB_NAME = 'rio-ventas-prod';
const PROD_BUCKET = 'rio-comprobantes-prod';

// Devuelve [{ header, lines }] con SOLO las líneas activas (sin comentarios ni vacías).
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

const esPreview = (h) => h === 'env.preview' || h.startsWith('env.preview.');
const esProduccion = (h) => h === 'env.production' || h.startsWith('env.production.');

test('wrangler.toml — conserva la configuración base de Pages (name, compatibility_date, pages_build_output_dir)', () => {
  const base = secciones()[0].lines.join('\n');
  assert.match(base, /^name = "rio-impulso-digital"$/m);
  assert.match(base, /^compatibility_date = "/m);
  assert.match(base, /^pages_build_output_dir = "\."$/m, 'sin esta clave wrangler.toml deja de ser la configuración de Pages');
});

test('wrangler.toml — NO hay ningún binding ni variable a nivel superior (se heredaría a Producción)', () => {
  const superior = secciones().filter((s) => !s.header.startsWith('env.'));
  const headers = superior.map((s) => s.header).filter(Boolean);
  assert.deepEqual(headers, [], 'todo binding/variable debe declararse dentro de [env.preview] o [env.production]: ' + headers.join(', '));
});

test('wrangler.toml — Preview apunta exclusivamente al D1 y al R2 de Preview', () => {
  const t = textoActivo(esPreview);
  assert.ok(t.includes('env.preview.d1_databases'), 'Preview debe declarar su D1');
  assert.ok(t.includes(`database_name = "${PREVIEW_DB_NAME}"`));
  assert.ok(t.includes(`database_id = "${PREVIEW_DB_ID}"`));
  assert.match(t, /binding = "DB"/);
  assert.ok(t.includes('env.preview.r2_buckets'), 'Preview debe declarar su R2');
  assert.ok(t.includes(`bucket_name = "${PREVIEW_BUCKET}"`));
  assert.match(t, /binding = "COMPROBANTES"/);
  assert.match(t, /CF_ACCESS_TEAM_DOMAIN = "/, 'Preview conserva su variable pública');
  assert.ok(!/-prod\b/.test(t), 'Preview nunca referencia recursos de Producción');
});

test('wrangler.toml — Producción NO referencia nada de Preview (ni el D1, ni su ID, ni el bucket)', () => {
  const t = textoActivo(esProduccion);
  assert.ok(t.includes('env.production'), 'debe existir la sección explícita de Producción');
  assert.ok(!t.includes(PREVIEW_DB_NAME), 'Producción no puede usar la base de Preview');
  assert.ok(!t.includes(PREVIEW_DB_ID), 'Producción no puede usar el database_id de Preview');
  assert.ok(!t.includes(PREVIEW_BUCKET), 'Producción no puede usar el bucket de Preview');
  assert.ok(!/preview/i.test(t), 'ninguna línea activa de Producción menciona Preview');
});

test('wrangler.toml — nunca queda un placeholder ni un ID inventado activo (el build de Pages valida este archivo)', () => {
  const activo = secciones().map((s) => [s.header, ...s.lines].join('\n')).join('\n');
  assert.ok(!/<COMPLETAR>|PENDIENTE_|TODO_ID/i.test(activo), 'un database_id placeholder hace fallar el deploy de Pages (RIO-110)');
});

test('wrangler.toml — los nombres productivos aprobados figuran en el archivo', () => {
  assert.ok(TOML.includes(PROD_DB_NAME), 'debe figurar rio-ventas-prod');
  assert.ok(TOML.includes(PROD_BUCKET), 'debe figurar rio-comprobantes-prod');
});

// Recursos reales de Producción (creados el 26/09/2026 con autorización de
// Brenda; ENAM; D1 vacía, R2 privado sin dominio público ni r2.dev). Era el
// GATE previo al merge a `main` (antes marcado `todo`): ahora se exige.
const PROD_DB_ID = '11132d3b-4016-482f-a7b5-24c026d89ffa';

test('Producción declara su propio D1 (rio-ventas-prod) y R2 (rio-comprobantes-prod), activos y exclusivos', () => {
  const t = textoActivo(esProduccion);
  assert.ok(t.includes('env.production.d1_databases'));
  assert.ok(t.includes(`database_name = "${PROD_DB_NAME}"`));
  assert.ok(t.includes(`database_id = "${PROD_DB_ID}"`), 'database_id real de rio-ventas-prod');
  assert.match(t, /binding = "DB"/);
  assert.ok(t.includes('env.production.r2_buckets'));
  assert.ok(t.includes(`bucket_name = "${PROD_BUCKET}"`));
  assert.match(t, /binding = "COMPROBANTES"/);
  assert.match(t, /CF_ACCESS_TEAM_DOMAIN = "/, 'Producción conserva su variable pública');
  assert.notEqual(PROD_DB_ID, PREVIEW_DB_ID, 'Producción y Preview jamás comparten base');
});

test('Cada entorno declara exactamente UN D1 y UN R2 (sin bindings duplicados ni cruzados)', () => {
  const headers = secciones().map((s) => s.header);
  for (const entorno of ['preview', 'production']) {
    assert.equal(headers.filter((h) => h === `env.${entorno}.d1_databases`).length, 1, `un solo D1 en ${entorno}`);
    assert.equal(headers.filter((h) => h === `env.${entorno}.r2_buckets`).length, 1, `un solo R2 en ${entorno}`);
  }
  const todosLosBindings = headers.filter((h) => /(d1_databases|r2_buckets)$/.test(h));
  assert.equal(todosLosBindings.length, 4, 'solo los 4 bindings esperados (2 por entorno), ninguno a nivel superior: ' + todosLosBindings.join(', '));
});
