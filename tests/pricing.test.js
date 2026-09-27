// Pruebas de functions/_shared/pricing.js — RIO-112.
// Verifica que sea un consumidor puro de la fuente canónica
// (interno/config/markets.js), no una copia — y que el prorrateo de packs
// sea siempre exacto y reproducible en todos los casos pedidos por Brenda
// (CL/AR, regular/lanzamiento, los 5 productos, importes que no dividen
// parejo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidPrice, splitPackPrice, isPromoActive, currentIndividualPrice, CURRENCY_BY_MARKET } from '../functions/_shared/pricing.js';
import { MARKETS } from '../interno/config/markets.js';

const MARKETS_LIST = ['CL', 'AR'];
const PRODUCTS = ['ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado'];
const PACKS = { ficha_generico: 'generico', ficha_personalizado: 'personalizado' };

test('pricing.js no define su propia tabla de precios — solo importa de markets.js (fuente única)', () => {
  const contenido = readFileSync(new URL('../functions/_shared/pricing.js', import.meta.url), 'utf8');
  assert.match(contenido, /import\s*\{[^}]*\}\s*from\s*['"]\.\.\/\.\.\/interno\/config\/markets\.js['"]/, 'debe importar de interno/config/markets.js');
  assert.doesNotMatch(contenido, /regular\s*:\s*\d+/, 'no debe contener valores de precio propios');
  assert.doesNotMatch(contenido, /promo\s*:\s*\d+/, 'no debe contener valores de precio propios');
});

test('markets.js expone MARKETS como export (módulo ES), no solo como global de navegador', () => {
  assert.ok(MARKETS.CL && MARKETS.AR, 'MARKETS debe ser importable directamente');
});

for (const market of MARKETS_LIST) {
  for (const product of PRODUCTS) {
    test(`isValidPrice() — ${market}/${product}: acepta el precio regular vigente (leído de markets.js)`, () => {
      const regular = MARKETS[market].products[product].regular;
      assert.equal(isValidPrice(market, product, 'regular', regular, '2026-08-28'), true);
    });

    test(`isValidPrice() — ${market}/${product}: acepta el precio de lanzamiento vigente (leído de markets.js)`, () => {
      const promo = MARKETS[market].products[product].promo;
      assert.equal(isValidPrice(market, product, 'lanzamiento', promo, '2026-08-28'), true);
    });

    test(`isValidPrice() — ${market}/${product}: rechaza un precio pactado distinto del publicado`, () => {
      const regular = MARKETS[market].products[product].regular;
      assert.equal(isValidPrice(market, product, 'regular', regular + 1, '2026-08-28'), false);
      assert.equal(isValidPrice(market, product, 'regular', 1, '2026-08-28'), false);
    });
  }
}

test('isValidPrice() — rechaza el precio de lanzamiento después del corte de promoción', () => {
  const promo = MARKETS.CL.products.ficha.promo;
  assert.equal(isValidPrice('CL', 'ficha', 'lanzamiento', promo, '2026-10-01'), false);
});

test('isValidPrice() — el precio regular sigue siendo válido después del corte de promoción', () => {
  const regular = MARKETS.CL.products.ficha.regular;
  assert.equal(isValidPrice('CL', 'ficha', 'regular', regular, '2026-10-01'), true);
});

test('isValidPrice() — producto o mercado inexistente devuelve false, nunca lanza', () => {
  assert.equal(isValidPrice('XX', 'ficha', 'regular', 130000), false);
  assert.equal(isValidPrice('CL', 'producto_inexistente', 'regular', 130000), false);
});

test('isPromoActive() — true antes o en la fecha de corte, false después', () => {
  assert.equal(isPromoActive('2026-09-30'), true);
  assert.equal(isPromoActive('2026-10-01'), false);
});

test('currentIndividualPrice() — devuelve el mismo valor que markets.js para cada mercado y producto', () => {
  for (const market of MARKETS_LIST) {
    for (const product of PRODUCTS) {
      const expectedPromo = MARKETS[market].products[product].promo;
      assert.equal(currentIndividualPrice(market, product, '2026-08-28'), expectedPromo);
    }
  }
});

// --- Prorrateo de packs: los dos packs, CL y AR, regular y lanzamiento ---
for (const market of MARKETS_LIST) {
  for (const packProduct of Object.keys(PACKS)) {
    const landingProduct = PACKS[packProduct];
    for (const tipoPrecio of ['regular', 'lanzamiento']) {
      test(`splitPackPrice() — ${market}/${packProduct} (${tipoPrecio}): suma exacta con los precios reales de markets.js`, () => {
        const packPrice = MARKETS[market].products[packProduct][tipoPrecio === 'lanzamiento' ? 'promo' : 'regular'];
        const fichaIndividual = MARKETS[market].products.ficha[tipoPrecio === 'lanzamiento' ? 'promo' : 'regular'];
        const landingIndividual = MARKETS[market].products[landingProduct][tipoPrecio === 'lanzamiento' ? 'promo' : 'regular'];
        const { precioFicha, precioLanding } = splitPackPrice(packPrice, fichaIndividual, landingIndividual);
        assert.equal(precioFicha + precioLanding, packPrice, 'nunca debe quedar 1 unidad de diferencia');
        assert.ok(precioFicha > 0 && precioLanding > 0);
      });
    }
  }
}

test('splitPackPrice() — importes que producen una división no exacta (tercios) igual suman exacto', () => {
  const casos = [
    [100000, 33333, 66667],
    [100001, 1, 2],
    [7, 1, 1],
    [999999, 333333, 333334],
    [90000, 1, 1], // caso extremo: proporción casi 50/50 con individuales chicos
  ];
  for (const [pactado, ficha, landing] of casos) {
    const { precioFicha, precioLanding } = splitPackPrice(pactado, ficha, landing);
    assert.equal(precioFicha + precioLanding, pactado, `caso [${pactado},${ficha},${landing}] no sumó exacto`);
  }
});

test('splitPackPrice() — es reproducible: mismos inputs producen siempre el mismo resultado', () => {
  const a = splitPackPrice(100000, 33333, 66667);
  const b = splitPackPrice(100000, 33333, 66667);
  assert.deepEqual(a, b);
});

test('splitPackPrice() — rechaza precios individuales que suman cero', () => {
  assert.throws(() => splitPackPrice(90000, 0, 0), RangeError);
});

test('CURRENCY_BY_MARKET — CL es CLP, AR es ARS', () => {
  assert.equal(CURRENCY_BY_MARKET.CL, 'CLP');
  assert.equal(CURRENCY_BY_MARKET.AR, 'ARS');
});
