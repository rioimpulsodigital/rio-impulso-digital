/*
 * Inventario central de recursos de Marketing — Portal Interno RiO Impulso Digital.
 * Arquitectura: RIO-91. Clasificación común/CL/AR: RIO-92 (secciones 9-10).
 * Verificación visual: RIO-93 (Anthy, 22 ago 2026).
 *
 * Las tarjetas de Marketing en interno/index.html se generan desde este arreglo —
 * nunca se escriben directamente en el HTML. estado: 'inactivo' nunca se renderiza.
 *
 * Nota de descubrimiento (RIO-93): al iniciar la implementación existían solo 3 piezas
 * (ficha-google.png, landingpage.png, ficha-landing.png — bundle CL de lanzamiento
 * antiguo, precios ya desactualizados). Durante esta misma tarea aparecieron en el
 * repositorio 10 piezas nuevas, ya producidas y correctas (5 CL + 5 AR, una por
 * producto), verificadas visualmente contra la matriz de RIO-92. Se adoptan como
 * inventario activo y las 3 piezas antiguas quedan retiradas (no borradas del disco).
 *
 * Autorización temporal (Brenda, 22 ago 2026): las 10 piezas activas usan el lema
 * "Fluye hacia el éxito". Quedan aprobadas para usarse tal cual durante el período de
 * lanzamiento (hasta el 30/09/2026 inclusive) — no se modificaron. DEBEN reemplazarse
 * por versiones actualizadas antes de que empiece a regir el precio regular, el
 * 01/10/2026 (mismo corte que gobierna markets.js vía isPromoActive()).
 */

var MARKETING_RESOURCES = [
  /* Chile — 5 piezas, una por producto */
  {
    id: 'mkt-ficha-google-cl',
    title: 'Ficha de Google',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/ficha-google-cl.png',
    format: 'image/png',
    description: 'Ficha de Google — $50.000 CLP lanzamiento / $130.000 CLP regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 1,
    alt: 'Servicio para Chile — Ficha de Google, $50.000 CLP',
    action: 'descargar'
  },
  {
    id: 'mkt-landing-express-cl',
    title: 'Landing Express',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/landing-express-cl.png',
    format: 'image/png',
    description: 'Landing Express — $50.000 CLP lanzamiento / $105.000 CLP regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 2,
    alt: 'Servicio para Chile — Landing Express, $50.000 CLP',
    action: 'descargar'
  },
  {
    id: 'mkt-landing-premium-cl',
    title: 'Landing Premium',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/landing-premium-cl.png',
    format: 'image/png',
    description: 'Landing Premium (dominio .cl incluido) — $60.000 CLP lanzamiento / $130.000 CLP regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 3,
    alt: 'Servicio para Chile — Landing Premium con dominio propio .cl, $60.000 CLP',
    action: 'descargar'
  },
  {
    id: 'mkt-ficha-landing-express-cl',
    title: 'Pack Ficha + Landing Express',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/ficha-landing-express-cl.png',
    format: 'image/png',
    description: 'Pack Ficha + Landing Express — $90.000 CLP lanzamiento / $210.000 CLP regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 4,
    alt: 'Pack para Chile — Ficha de Google + Landing Express, $90.000 CLP',
    action: 'descargar'
  },
  {
    id: 'mkt-ficha-landing-premium-cl',
    title: 'Pack Ficha + Landing Premium',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/ficha-landing-premium-cl.png',
    format: 'image/png',
    description: 'Pack Ficha + Landing Premium — $100.000 CLP lanzamiento / $235.000 CLP regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 5,
    alt: 'Pack para Chile — Ficha de Google + Landing Premium, $100.000 CLP',
    action: 'descargar'
  },

  /* Argentina — 5 piezas, una por producto */
  {
    id: 'mkt-ficha-google-ar',
    title: 'Ficha de Google',
    category: 'estados-historias',
    market: 'AR',
    file: './img 1080x1920/ficha-google-ar.png',
    format: 'image/png',
    description: 'Ficha de Google — $125.000 ARS lanzamiento / $215.000 ARS regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 1,
    alt: 'Servicio para Argentina — Ficha de Google, $125.000 ARS',
    action: 'descargar'
  },
  {
    id: 'mkt-landing-express-ar',
    title: 'Landing Express',
    category: 'estados-historias',
    market: 'AR',
    file: './img 1080x1920/landing-express-ar.png',
    format: 'image/png',
    description: 'Landing Express — $120.000 ARS lanzamiento / $185.000 ARS regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 2,
    alt: 'Servicio para Argentina — Landing Express, $120.000 ARS',
    action: 'descargar'
  },
  {
    id: 'mkt-landing-premium-ar',
    title: 'Landing Premium',
    category: 'estados-historias',
    market: 'AR',
    file: './img 1080x1920/landing-premium-ar.png',
    format: 'image/png',
    description: 'Landing Premium (dominio .com.ar incluido) — $150.000 ARS lanzamiento / $230.000 ARS regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 3,
    alt: 'Servicio para Argentina — Landing Premium con dominio propio .com.ar, $150.000 ARS',
    action: 'descargar'
  },
  {
    id: 'mkt-ficha-landing-express-ar',
    title: 'Pack Ficha + Landing Express',
    category: 'estados-historias',
    market: 'AR',
    file: './img 1080x1920/ficha-landing-express-ar.png',
    format: 'image/png',
    description: 'Pack Ficha + Landing Express — $220.000 ARS lanzamiento / $360.000 ARS regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 4,
    alt: 'Pack para Argentina — Ficha de Google + Landing Express, $220.000 ARS',
    action: 'descargar'
  },
  {
    id: 'mkt-ficha-landing-premium-ar',
    title: 'Pack Ficha + Landing Premium',
    category: 'estados-historias',
    market: 'AR',
    file: './img 1080x1920/ficha-landing-premium-ar.png',
    format: 'image/png',
    description: 'Pack Ficha + Landing Premium — $250.000 ARS lanzamiento / $400.000 ARS regular',
    vigencia: '2026-09-30',
    estado: 'activo',
    orden: 5,
    alt: 'Pack para Argentina — Ficha de Google + Landing Premium, $250.000 ARS',
    action: 'descargar'
  },

  /* Retiradas — bundle antiguo de lanzamiento (3 piezas, precios desactualizados y no
     separadas por producto). No se borran del disco; quedan fuera del inventario activo. */
  {
    id: 'mkt-legacy-ficha-google',
    title: 'Ficha Google (bundle antiguo)',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/ficha-google.png',
    format: 'image/png',
    description: 'Reemplazada por mkt-ficha-google-cl — precio desactualizado ($50.000 sin distinguir lanzamiento/regular)',
    vigencia: null,
    estado: 'inactivo',
    orden: 99,
    alt: null,
    action: null
  },
  {
    id: 'mkt-legacy-landingpage',
    title: 'Landing Page (bundle antiguo)',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/landingpage.png',
    format: 'image/png',
    description: 'Reemplazada por mkt-landing-express-cl y mkt-landing-premium-cl',
    vigencia: null,
    estado: 'inactivo',
    orden: 99,
    alt: null,
    action: null
  },
  {
    id: 'mkt-legacy-ficha-landing',
    title: 'Promo Ficha + Landing (bundle antiguo)',
    category: 'estados-historias',
    market: 'CL',
    file: './img 1080x1920/ficha-landing.png',
    format: 'image/png',
    description: 'Reemplazada por mkt-ficha-landing-express-cl y mkt-ficha-landing-premium-cl',
    vigencia: null,
    estado: 'inactivo',
    orden: 99,
    alt: null,
    action: null
  }
];
