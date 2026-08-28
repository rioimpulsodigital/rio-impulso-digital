// Precios y distribución proporcional de packs — RIO-112.
//
// DECISIÓN DE DISEÑO A CONFIRMAR CON BRENDA (documentada, no silenciosa):
// interno/config/markets.js es la fuente de precios que ya usa el Kit hoy,
// pero es un script clásico (`var MARKETS = {...}`, sin `export`) pensado
// para cargarse con <script src> en el navegador — no es importable
// directamente por una Pages Function (ES module). Convertirlo a módulo
// ES rompería el orden de carga de las páginas que ya lo consumen así
// (kit-venta-ficha-y-landing-page.html, capacitacion-ficha-landing.html),
// un riesgo real sobre páginas que se usan a diario, y fuera del alcance
// de "ventas, proyectos y componentes" que pide RIO-112.
//
// Por eso esta tabla es una copia deliberada, no una importación — mismo
// tipo de decisión que RIO-97 v2 ya aceptó para `users.js` (mantenerlo
// separado de D1 para lo que hace bien), pero acá el riesgo es distinto:
// los precios cambian rara vez y siempre de forma deliberada y revisada
// por Brenda (RIO-92/93), a diferencia del plantel de ejecutivos. Aun así,
// es una segunda lista que puede desincronizarse — si Brenda prefiere que
// el servidor lea la fuente única real, la alternativa (convertir
// markets.js a módulo ES con export + reasignación a `window` para no
// romper los scripts clásicos existentes) queda lista para hacerse en una
// tarea aparte.
//
// Mientras tanto: el precio pactado de la venta lo define el ejecutivo en
// el Kit (ya usa esta misma tabla hoy) y se envía al crear la venta — este
// módulo solo VALIDA que ese precio sea uno de los vigentes (regular o de
// lanzamiento) para ese producto/mercado, y hace el prorrateo del pack con
// los precios individuales de referencia que también viajan en la
// solicitud (ver functions/interno/api/ventas/index.js).

export const PROMO_END_DATE = '2026-09-30';

export const PRICE_TABLE = Object.freeze({
  CL: {
    ficha: { regular: 130000, promo: 50000 },
    generico: { regular: 105000, promo: 50000 },
    personalizado: { regular: 130000, promo: 60000 },
    ficha_generico: { regular: 210000, promo: 90000 },
    ficha_personalizado: { regular: 235000, promo: 100000 },
  },
  AR: {
    ficha: { regular: 215000, promo: 125000 },
    generico: { regular: 185000, promo: 120000 },
    personalizado: { regular: 230000, promo: 150000 },
    ficha_generico: { regular: 360000, promo: 220000 },
    ficha_personalizado: { regular: 400000, promo: 250000 },
  },
});

export const CURRENCY_BY_MARKET = Object.freeze({ CL: 'CLP', AR: 'ARS' });

export function isPromoActive(referenceDate) {
  const now = referenceDate ? new Date(referenceDate) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayUTC = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  return todayUTC <= PROMO_END_DATE;
}

// Valida que un precio pactado corresponda a uno de los dos precios
// vigentes (regular o lanzamiento) para ese producto/mercado en la fecha
// dada — nunca acepta un valor arbitrario del cliente.
export function isValidPrice(market, product, tipoPrecio, precio, referenceDate) {
  const entry = PRICE_TABLE[market]?.[product];
  if (!entry) return false;
  const expected = tipoPrecio === 'lanzamiento' ? entry.promo : entry.regular;
  if (tipoPrecio === 'lanzamiento' && !isPromoActive(referenceDate)) return false; // no se puede pactar promo vencida.
  return precio === expected;
}

// Distribución proporcional del precio de un pack entre sus dos
// componentes, usando los precios individuales de referencia (RIO-97 v2
// sección 6). Redondea el primero (ficha) y calcula el segundo (landing)
// como el resto — garantiza que la suma sea EXACTAMENTE precioPactado,
// sin arrastre de redondeo.
export function splitPackPrice(precioPactado, precioFichaIndividual, precioLandingIndividual) {
  const totalIndividual = precioFichaIndividual + precioLandingIndividual;
  if (totalIndividual <= 0) throw new RangeError('la suma de precios individuales debe ser mayor a cero');
  const precioFicha = Math.round((precioPactado * precioFichaIndividual) / totalIndividual);
  const precioLanding = precioPactado - precioFicha;
  return { precioFicha, precioLanding };
}
