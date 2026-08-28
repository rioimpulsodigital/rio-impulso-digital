// Pruebas de functions/_shared/pricing.js — RIO-112.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPrice, splitPackPrice, isPromoActive, PRICE_TABLE, CURRENCY_BY_MARKET } from '../functions/_shared/pricing.js';

test('isValidPrice() — acepta el precio de lanzamiento vigente', () => {
  assert.equal(isValidPrice('CL', 'ficha', 'lanzamiento', 50000, '2026-08-28'), true);
});

test('isValidPrice() — acepta el precio regular', () => {
  assert.equal(isValidPrice('CL', 'ficha', 'regular', 130000, '2026-08-28'), true);
});

test('isValidPrice() — rechaza un monto arbitrario que no corresponde a ningún precio vigente', () => {
  assert.equal(isValidPrice('CL', 'ficha', 'lanzamiento', 1, '2026-08-28'), false);
});

test('isValidPrice() — rechaza el precio de lanzamiento después del corte de promoción', () => {
  assert.equal(isValidPrice('CL', 'ficha', 'lanzamiento', 50000, '2026-10-01'), false);
});

test('isValidPrice() — el precio regular sigue siendo válido después del corte de promoción', () => {
  assert.equal(isValidPrice('CL', 'ficha', 'regular', 130000, '2026-10-01'), true);
});

test('isValidPrice() — producto o mercado inexistente devuelve false, nunca lanza', () => {
  assert.equal(isValidPrice('XX', 'ficha', 'regular', 130000), false);
  assert.equal(isValidPrice('CL', 'producto_inexistente', 'regular', 130000), false);
});

test('isPromoActive() — true antes o en la fecha de corte, false después', () => {
  assert.equal(isPromoActive('2026-09-30'), true);
  assert.equal(isPromoActive('2026-10-01'), false);
});

test('splitPackPrice() — la suma de los dos componentes es EXACTAMENTE el precio pactado (sin arrastre de redondeo)', () => {
  // Caso real: CL, Ficha+Landing Express lanzamiento = $90.000; individuales $50.000 y $50.000.
  const { precioFicha, precioLanding } = splitPackPrice(90000, 50000, 50000);
  assert.equal(precioFicha + precioLanding, 90000);
  assert.equal(precioFicha, 45000);
  assert.equal(precioLanding, 45000);
});

test('splitPackPrice() — reparto no equitativo también suma exacto (con redondeo)', () => {
  // Precios individuales distintos → proporción no 50/50.
  const { precioFicha, precioLanding } = splitPackPrice(100000, 33333, 66667);
  assert.equal(precioFicha + precioLanding, 100000);
});

test('splitPackPrice() — es reproducible: mismos inputs producen siempre el mismo resultado', () => {
  const a = splitPackPrice(100000, 33333, 66667);
  const b = splitPackPrice(100000, 33333, 66667);
  assert.deepEqual(a, b);
});

test('splitPackPrice() — rechaza precios individuales que suman cero', () => {
  assert.throws(() => splitPackPrice(90000, 0, 0), RangeError);
});

test('PRICE_TABLE — tiene las 5 combinaciones de producto para CL y AR', () => {
  for (const market of ['CL', 'AR']) {
    for (const product of ['ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado']) {
      assert.ok(PRICE_TABLE[market][product], `falta ${market}/${product}`);
    }
  }
});

test('CURRENCY_BY_MARKET — CL es CLP, AR es ARS', () => {
  assert.equal(CURRENCY_BY_MARKET.CL, 'CLP');
  assert.equal(CURRENCY_BY_MARKET.AR, 'ARS');
});
