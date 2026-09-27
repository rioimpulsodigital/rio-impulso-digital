// Precios y distribución proporcional de packs — RIO-112.
//
// Fuente canónica única de precios: interno/config/markets.js — este
// módulo la IMPORTA directamente, nunca copia sus valores. Decisión
// tomada tras auditoría de Brenda (28/08/2026): markets.js pasó a ser un
// módulo ES (además de las funciones que ya tenía) precisamente para que
// tanto el navegador (<script type="module">) como esta Pages Function
// (`import`) lean el mismo archivo — ver el encabezado de markets.js para
// el detalle completo de esa decisión y por qué no se optó por JSON
// estático ni por que el backend le pregunte algo al frontend.
//
// Este archivo NO lee el código fuente de markets.js como texto ni con
// expresiones regulares — es un `import` de ES modules estándar,
// resuelto y empaquetado por el bundler de Pages Functions como cualquier
// otro import del proyecto.

import { MARKETS, isPromoActive as isPromoActiveCanonical, getActivePrice } from '../../interno/config/markets.js';

export const CURRENCY_BY_MARKET = Object.freeze({ CL: 'CLP', AR: 'ARS' });

export const isPromoActive = isPromoActiveCanonical;

// Valida que un precio pactado corresponda a uno de los dos precios
// vigentes (regular o de campaña) para ese producto/mercado en la fecha
// dada — nunca acepta un valor arbitrario enviado por el cliente. Usa
// getActivePrice() de la fuente canónica, no una copia propia.
export function isValidPrice(market, product, tipoPrecio, precio, referenceDate) {
  const entry = MARKETS[market]?.products?.[product];
  if (!entry) return false;
  if (tipoPrecio === 'lanzamiento' && !isPromoActive(referenceDate)) return false; // no se puede pactar una promo vencida.
  const expected = tipoPrecio === 'lanzamiento' ? entry.promo : entry.regular;
  return precio === expected;
}

// Precio individual vigente de un producto — usado por ventas/index.js
// para validar los precios de referencia del prorrateo de un pack contra
// la fuente canónica (nunca acepta un valor de referencia arbitrario).
export function currentIndividualPrice(market, product, referenceDate) {
  return getActivePrice(market, product, referenceDate);
}

// Distribución proporcional del precio de un pack entre sus dos
// componentes, usando los precios individuales de referencia vigentes al
// momento de la venta (RIO-97 v2 sección 6 · RIO-112). Redondea el primero
// (ficha) y calcula el segundo (landing) como el resto — garantiza que la
// suma sea EXACTAMENTE precioPactado, sin arrastre de redondeo, sin
// importar cuán "feos" sean los números de entrada.
export function splitPackPrice(precioPactado, precioFichaIndividual, precioLandingIndividual) {
  const totalIndividual = precioFichaIndividual + precioLandingIndividual;
  if (totalIndividual <= 0) throw new RangeError('la suma de precios individuales debe ser mayor a cero');
  const precioFicha = Math.round((precioPactado * precioFichaIndividual) / totalIndividual);
  const precioLanding = precioPactado - precioFicha;
  return { precioFicha, precioLanding };
}
