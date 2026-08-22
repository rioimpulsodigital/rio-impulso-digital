/*
 * Configuración comercial central por mercado — Portal Interno RiO Impulso Digital.
 * Arquitectura: RIO-91. Precios y condiciones: RIO-92 (Matriz Definitiva Aprobada por
 * Brenda, 20 ago 2026). Modalidad de pago diferenciada CL/AR: RIO-93.
 *
 * Vigencia de lanzamiento: hasta el 30/09/2026 inclusive.
 * Desde el 01/10/2026 rige el precio regular — sin cambiar manualmente ningún archivo.
 */

var PROMO_END_DATE = '2026-09-30';

// referenceDate es opcional — permite probar el corte de promoción sin tocar código
// (ej. en consola: isPromoActive('2026-10-01') → false).
// Compara fechas calendario en UTC en ambos lados (evita que el resultado dependa
// de la zona horaria del navegador — CL y AR están a solo 3-4h de UTC, diferencia
// despreciable para un corte de vigencia por fecha, no por instante exacto).
function isPromoActive(referenceDate) {
  var now = referenceDate ? new Date(referenceDate) : new Date();
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var todayUTC = now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate());
  return todayUTC <= PROMO_END_DATE;
}

var MARKETS = {
  CL: {
    country: 'Chile',
    currency: 'CLP',
    formatPrice: function (n) { return '$' + n.toLocaleString('es-CL'); },
    domainExample: 'tunegocio.cl',
    paymentMethod: 'mercadopago_link',
    products: {
      ficha: {
        label: 'Ficha de Google',
        regular: 130000, promo: 50000,
        paymentPlan: '100',
        paymentLink: 'https://mpago.la/2u2x2cK',
        linkChargesAmount: 50000
      },
      generico: {
        label: 'Landing Express',
        regular: 105000, promo: 50000,
        paymentPlan: '100',
        paymentLink: 'https://mpago.la/2tiWxC7',
        linkChargesAmount: 50000
      },
      personalizado: {
        label: 'Landing Premium',
        regular: 130000, promo: 60000,
        paymentPlan: '100',
        paymentLink: 'https://mpago.la/1BhuLBq',
        linkChargesAmount: 60000
      },
      ficha_generico: {
        label: 'Ficha de Google + Landing Express',
        regular: 210000, promo: 90000,
        paymentPlan: '50-50',
        // Enlace autorizado por Brenda (22 ago 2026) — cobra el primer 50% del precio
        // de lanzamiento ($45.000). Solo válido mientras isPromoActive() sea true;
        // getPaymentLinkConflict() lo bloquea automáticamente desde el 01/10/2026.
        paymentLink: 'https://mpago.la/2fzLSZz',
        linkChargesAmount: 45000
      },
      ficha_personalizado: {
        label: 'Ficha de Google + Landing Premium',
        regular: 235000, promo: 100000,
        paymentPlan: '50-50',
        // Enlace autorizado por Brenda (22 ago 2026) — cobra el primer 50% del precio
        // de lanzamiento ($50.000). Solo válido mientras isPromoActive() sea true;
        // getPaymentLinkConflict() lo bloquea automáticamente desde el 01/10/2026.
        paymentLink: 'https://mpago.la/1jRmDzX',
        linkChargesAmount: 50000
      }
    }
  },
  AR: {
    country: 'Argentina',
    currency: 'ARS',
    formatPrice: function (n) { return '$' + n.toLocaleString('es-AR'); },
    domainExample: 'tunegocio.com.ar',
    paymentMethod: 'bank_transfer',
    transfer: {
      alias: 'rioimpulsodigital',
      cvu: '0000003100083053731840',
      titular: 'Brenda Rebeca Rivera Obando'
    },
    products: {
      ficha: {
        label: 'Ficha de Google',
        regular: 215000, promo: 125000,
        paymentPlan: '100'
      },
      generico: {
        label: 'Landing Express',
        regular: 185000, promo: 120000,
        paymentPlan: '50-50'
      },
      personalizado: {
        label: 'Landing Premium',
        regular: 230000, promo: 150000,
        paymentPlan: '50-50'
      },
      ficha_generico: {
        label: 'Ficha de Google + Landing Express',
        regular: 360000, promo: 220000,
        paymentPlan: '50-50'
      },
      ficha_personalizado: {
        label: 'Ficha de Google + Landing Premium',
        regular: 400000, promo: 250000,
        paymentPlan: '50-50'
      }
    }
  }
};

function getActivePrice(market, productKey, referenceDate) {
  var product = MARKETS[market].products[productKey];
  return isPromoActive(referenceDate) ? product.promo : product.regular;
}

// { plan, total, initial, balance } — balance es 0 cuando el plan es '100'.
function getPaymentTerms(market, productKey, referenceDate) {
  var product = MARKETS[market].products[productKey];
  var total = getActivePrice(market, productKey, referenceDate);
  if (product.paymentPlan === '100') {
    return { plan: '100', total: total, initial: total, balance: 0 };
  }
  var initial = Math.round(total / 2);
  return { plan: '50-50', total: total, initial: initial, balance: total - initial };
}

// Solo aplica a Chile — Argentina no usa enlaces de pago (transferencia bancaria).
// Compara lo que el enlace de Mercado Pago existente cobra realmente contra lo que
// corresponde cobrar ahora (según promo/regular vigente y el plan de pago del producto).
// Nunca inventa ni reemplaza un enlace — solo detecta el desajuste para bloquear el envío.
// Devuelve null si no hay conflicto, o un motivo string si lo hay.
function getPaymentLinkConflict(productKey, referenceDate) {
  var product = MARKETS.CL.products[productKey];
  if (!product.paymentLink) return 'sin_link';
  var terms = getPaymentTerms('CL', productKey, referenceDate);
  var requiredCharge = terms.plan === '100' ? terms.total : terms.initial;
  if (product.linkChargesAmount !== requiredCharge) return 'monto_no_coincide';
  return null;
}
