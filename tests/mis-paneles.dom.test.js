// Pruebas de DOM real (jsdom) — "Mis paneles" en interno/index.html, RIO-123
// (27/09/2026). Parsean el documento REAL completo (sin ejecutar sus scripts
// inline: `outside-only`) y evalúan encima el código REAL de
// renderMisPaneles() (marcadores MIS-PANELES:INICIO/FIN) — nunca una
// reimplementación — invocándolo directamente en cada prueba, sin depender
// del resto de la lógica de la página (mercado, marketing, etc.).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_FUENTE = fs.readFileSync(path.join(ROOT, 'interno/index.html'), 'utf8');

// Extrae el código JS real entre los comentarios /* MIS-PANELES:INICIO */ y
// /* MIS-PANELES:FIN */ — se salta la línea completa de cada marcador (no solo
// el texto del marcador) para no dejar un "/*" o "*/" huérfano en el recorte.
function extraerBloqueJs(texto, inicio, fin) {
  const iMarca = texto.indexOf(inicio);
  const jMarca = texto.indexOf(fin, iMarca);
  assert.ok(iMarca >= 0 && jMarca > iMarca, `marcadores "${inicio}"/"${fin}" presentes en interno/index.html`);
  const desde = texto.indexOf('\n', iMarca) + 1;
  const hasta = texto.lastIndexOf('\n', jMarca) + 1;
  return texto.slice(desde, hasta);
}

const SCRIPT_JS = extraerBloqueJs(HTML_FUENTE, 'MIS-PANELES:INICIO', 'MIS-PANELES:FIN');

// Documento REAL completo (parseado, no ejecutado: `outside-only` corre
// scripts externos pero nunca los inline de esta página — market switcher,
// marketing, etc. quedan fuera, tal como se busca) — así #section-paneles,
// #panelesCards y #panelesVacio son exactamente el markup shippeado, sin
// reconstruir sus límites a mano. Solo se evalúa encima el bloque real de
// renderMisPaneles(), para invocarlo directamente en cada prueba.
function montar() {
  const dom = new JSDOM(HTML_FUENTE, { url: 'https://rioimpulsodigital.com/interno/', runScripts: 'outside-only' });
  dom.window.eval(SCRIPT_JS);
  return dom;
}

function textoTarjetas(dom) {
  return [...dom.window.document.querySelectorAll('#panelesCards .ut-card')].map((a) => ({
    panel: a.getAttribute('data-panel'), href: a.getAttribute('href'), titulo: a.querySelector('h3').textContent,
  }));
}

test('usuario con 1 panel (ejecutivo) ve una sola tarjeta: Panel Vendedor, con el destino y el texto pedidos', () => {
  const dom = montar();
  dom.window.renderMisPaneles({ panelesAutorizados: ['vendedor'] });
  const tarjetas = textoTarjetas(dom);
  assert.equal(tarjetas.length, 1);
  assert.deepEqual(tarjetas[0], { panel: 'vendedor', href: './panel-vendedor.html', titulo: 'Panel Vendedor' });
  assert.ok(dom.window.document.querySelector('#panelesCards .ut-card p').textContent.includes('Consulta tus ventas, comisiones'));
  assert.equal(dom.window.document.getElementById('section-paneles').hidden, false);
  assert.equal(dom.window.document.getElementById('panelesVacio').hidden, true);
});

test('usuario multirrol (admin) recibe todas sus autorizaciones: 3 tarjetas, en el orden servido por whoami', () => {
  const dom = montar();
  dom.window.renderMisPaneles({ panelesAutorizados: ['vendedor', 'supervisor', 'administrativo'] });
  const tarjetas = textoTarjetas(dom);
  assert.equal(tarjetas.length, 3);
  assert.deepEqual(tarjetas.map((t) => t.panel), ['vendedor', 'supervisor', 'administrativo']);
  assert.deepEqual(tarjetas.map((t) => t.href), ['./panel-vendedor.html', './panel-supervisor.html', './panel-administrativo.html']);
});

test('usuario autenticado sin panel asignado: sin tarjetas, mensaje neutro visible, sección igual visible (el resto del Portal sigue disponible)', () => {
  const dom = montar();
  dom.window.renderMisPaneles({ panelesAutorizados: [] });
  assert.equal(textoTarjetas(dom).length, 0);
  assert.equal(dom.window.document.getElementById('section-paneles').hidden, false);
  const vacio = dom.window.document.getElementById('panelesVacio');
  assert.equal(vacio.hidden, false);
  assert.equal(vacio.textContent, 'No tienes paneles de gestión asignados actualmente.');
});

test('usuario no reconocido (whoami sin identidad): la sección de paneles queda oculta, sin tarjetas ni mensaje', () => {
  const dom = montar();
  dom.window.renderMisPaneles(null);
  assert.equal(dom.window.document.getElementById('section-paneles').hidden, true);
  assert.equal(textoTarjetas(dom).length, 0);
});

test('un id de panel desconocido/futuro que el servidor llegara a enviar se ignora, nunca rompe el render de los demás', () => {
  const dom = montar();
  dom.window.renderMisPaneles({ panelesAutorizados: ['vendedor', 'algo-nuevo-no-catalogado'] });
  const tarjetas = textoTarjetas(dom);
  assert.deepEqual(tarjetas.map((t) => t.panel), ['vendedor']);
});
