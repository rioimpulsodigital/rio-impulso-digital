// GET/POST /interno/api/ventas — RIO-112.
//
// GET: lista de ventas, con alcance según rol (RIO-97 v2 sección 4/5):
//   - ejecutivo: solo las suyas (ejecutivo_email = su email).
//   - supervisor/admin: las de sus mercados autorizados (nunca "todas" sin
//     condición — ver assertMarketAllowed/roleIdentity.allowedMarkets).
//   - asistente: 403 — la matriz de permisos de RIO-97 v2 no le da acceso a
//     nivel de venta, solo a componentes asignados (tabla de asignación
//     todavía no existe, RIO-97 v2 documenta el rol como "hoy sin nadie
//     asignado" — fuera de alcance de RIO-112, no se anticipa acá).
//
// POST: registra una venta y, en cascada y atómica (un solo db.batch()),
// su proyecto y 1-2 componentes según el producto. Individual = 1
// componente; pack = 2, con el precio distribuido proporcionalmente usando
// los precios individuales de referencia que viajan en la solicitud (ver
// functions/_shared/pricing.js sobre por qué no se importa markets.js acá).

import { ok, Errors } from '../../../_shared/response.js';
import { query, transaction } from '../../../_shared/db.js';
import { assertMarketAllowed, AuthzError } from '../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType, isBodyTooLarge } from '../../../_shared/security.js';
import { isValidPrice, splitPackPrice, CURRENCY_BY_MARKET } from '../../../_shared/pricing.js';

const PACK_LANDING_PRODUCT = {
  ficha_generico: 'generico',
  ficha_personalizado: 'personalizado',
};
const VALID_PRODUCTS = ['ficha', 'generico', 'personalizado', 'ficha_generico', 'ficha_personalizado'];
const VALID_TIPO_PRECIO = ['regular', 'lanzamiento'];
const VALID_MERCADOS = ['CL', 'AR'];

function isPack(producto) {
  return producto === 'ficha_generico' || producto === 'ficha_personalizado';
}

function shortCode(prefix) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `${prefix}-${date}-${suffix}`;
}

function serializeVenta(row) {
  return {
    id: row.id,
    codigoVenta: row.codigo_venta,
    cliente: { id: row.cliente_id, negocio: row.negocio },
    mercado: row.mercado,
    producto: row.producto,
    moneda: row.moneda,
    tipoPrecio: row.tipo_precio,
    precioPactado: row.precio_pactado,
    ejecutivoEmail: row.ejecutivo_email,
    estadoActual: row.estado_actual,
    createdAt: row.created_at,
  };
}

async function handleList(context) {
  const { env, data } = context;
  const { requestId, roleIdentity } = data;

  if (roleIdentity.role === 'asistente') {
    return Errors.forbidden(requestId);
  }

  let rows;
  if (roleIdentity.role === 'ejecutivo') {
    rows = await query(
      env.DB,
      requestId,
      `SELECT v.*, c.negocio FROM ventas v JOIN clientes c ON c.id = v.cliente_id
       WHERE v.ejecutivo_email = ? ORDER BY v.created_at DESC`,
      [roleIdentity.email]
    );
  } else {
    // admin/supervisor: limitado a sus propios mercados autorizados —
    // nunca "todas las ventas" sin condición (RIO-97 v2 sección 4).
    if (roleIdentity.allowedMarkets.length === 0) {
      return ok({ ventas: [] }, requestId);
    }
    const placeholders = roleIdentity.allowedMarkets.map(() => '?').join(',');
    rows = await query(
      env.DB,
      requestId,
      `SELECT v.*, c.negocio FROM ventas v JOIN clientes c ON c.id = v.cliente_id
       WHERE v.mercado IN (${placeholders}) ORDER BY v.created_at DESC`,
      roleIdentity.allowedMarkets
    );
  }

  return ok({ ventas: rows.map(serializeVenta) }, requestId);
}

async function handleCreate(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (roleIdentity.role === 'asistente') {
    return Errors.forbidden(requestId);
  }

  if (!hasExpectedContentType(request)) {
    return Errors.validation('Content-Type debe ser application/json.', requestId);
  }
  if (isBodyTooLarge(request)) {
    return Errors.validation('La solicitud es demasiado grande.', requestId);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const { mercado, cliente, producto, tipoPrecio, precioPactado, precioFichaIndividual, precioLandingIndividual } = body || {};

  if (!VALID_MERCADOS.includes(mercado)) {
    return Errors.validation('Mercado inválido.', requestId);
  }
  try {
    assertMarketAllowed(roleIdentity, mercado);
  } catch (e) {
    if (e instanceof AuthzError) return Errors.forbidden(requestId);
    throw e;
  }
  if (!cliente || typeof cliente.negocio !== 'string' || !cliente.negocio.trim()) {
    return Errors.validation('Falta el nombre del negocio del cliente.', requestId);
  }
  if (!VALID_PRODUCTS.includes(producto)) {
    return Errors.validation('Producto inválido.', requestId);
  }
  if (!VALID_TIPO_PRECIO.includes(tipoPrecio)) {
    return Errors.validation('Tipo de precio inválido.', requestId);
  }
  if (!Number.isInteger(precioPactado) || precioPactado <= 0) {
    return Errors.validation('Precio pactado inválido.', requestId);
  }
  if (!isValidPrice(mercado, producto, tipoPrecio, precioPactado)) {
    return Errors.validation('El precio pactado no corresponde a un precio vigente para ese producto y mercado.', requestId);
  }
  if (mercado === 'AR' && cliente.datosFacturacionAr && typeof cliente.datosFacturacionAr !== 'string') {
    return Errors.validation('datosFacturacionAr debe ser texto.', requestId);
  }

  const pack = isPack(producto);
  let componentesPlan;
  if (pack) {
    if (!Number.isInteger(precioFichaIndividual) || !Number.isInteger(precioLandingIndividual)) {
      return Errors.validation('Un pack requiere precioFichaIndividual y precioLandingIndividual.', requestId);
    }
    const landingProduct = PACK_LANDING_PRODUCT[producto];
    if (!isValidPrice(mercado, 'ficha', tipoPrecio, precioFichaIndividual)) {
      return Errors.validation('precioFichaIndividual no corresponde a un precio vigente.', requestId);
    }
    if (!isValidPrice(mercado, landingProduct, tipoPrecio, precioLandingIndividual)) {
      return Errors.validation('precioLandingIndividual no corresponde a un precio vigente.', requestId);
    }
    let split;
    try {
      split = splitPackPrice(precioPactado, precioFichaIndividual, precioLandingIndividual);
    } catch (e) {
      return Errors.validation('No se pudo calcular la distribución del pack.', requestId);
    }
    componentesPlan = [
      { tipo: 'ficha', precioIndividualReferencia: precioFichaIndividual, precioAtribuido: split.precioFicha, estado: 'pendiente' },
      { tipo: 'landing', precioIndividualReferencia: precioLandingIndividual, precioAtribuido: split.precioLanding, estado: 'bloqueada' },
    ];
  } else {
    const tipo = producto === 'ficha' ? 'ficha' : 'landing';
    componentesPlan = [
      { tipo, precioIndividualReferencia: precioPactado, precioAtribuido: precioPactado, estado: 'pendiente' },
    ];
  }

  const moneda = CURRENCY_BY_MARKET[mercado];
  const clienteId = crypto.randomUUID();
  const ventaId = crypto.randomUUID();
  const proyectoId = crypto.randomUUID();
  const codigoVenta = shortCode('V');
  const codigoProyecto = shortCode('P');

  // RIO-113: pagos esperados de la venta — 1 fila (100%) si es individual,
  // 2 (inicial 50% + saldo 50%) si es pack. Mismo criterio de redondeo
  // exacto que el prorrateo de componentes (RIO-112): se redondea el
  // primero, el segundo es el resto — la suma siempre da precioPactado.
  const pagosPlan = pack
    ? (() => {
        const inicial = Math.round(precioPactado / 2);
        return [
          { tipo: 'inicial', monto: inicial },
          { tipo: 'saldo', monto: precioPactado - inicial },
        ];
      })()
    : [{ tipo: 'total', monto: precioPactado }];

  const db = env.DB;
  const statements = [
    db.prepare('INSERT INTO clientes (id, negocio, contacto_nombre, telefono, email, mercado, datos_facturacion_ar, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(clienteId, cliente.negocio.trim(), cliente.contactoNombre || null, cliente.telefono || null, cliente.email || null, mercado, cliente.datosFacturacionAr || null, roleIdentity.email),
    db.prepare('INSERT INTO ventas (id, codigo_venta, cliente_id, mercado, producto, moneda, tipo_precio, precio_pactado, ejecutivo_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ventaId, codigoVenta, clienteId, mercado, producto, moneda, tipoPrecio, precioPactado, roleIdentity.email),
    db.prepare('INSERT INTO proyectos (id, venta_id, codigo_proyecto) VALUES (?, ?, ?)')
      .bind(proyectoId, ventaId, codigoProyecto),
    ...componentesPlan.map((c) =>
      db.prepare('INSERT INTO componentes (id, proyecto_id, tipo, precio_individual_referencia, precio_atribuido, estado_actual) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), proyectoId, c.tipo, c.precioIndividualReferencia, c.precioAtribuido, c.estado)
    ),
    ...pagosPlan.map((p) =>
      db.prepare('INSERT INTO pagos_esperados (id, venta_id, tipo, monto, moneda) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), ventaId, p.tipo, p.monto, moneda)
    ),
  ];

  try {
    await transaction(db, requestId, statements);
  } catch (e) {
    return Errors.internal(requestId);
  }

  return ok(
    {
      venta: {
        id: ventaId,
        codigoVenta,
        mercado,
        producto,
        moneda,
        tipoPrecio,
        precioPactado,
        ejecutivoEmail: roleIdentity.email,
      },
      proyecto: { id: proyectoId, codigoProyecto },
      componentes: componentesPlan.map((c) => ({ tipo: c.tipo, precioAtribuido: c.precioAtribuido, estadoActual: c.estado })),
      pagosEsperados: pagosPlan.map((p) => ({ tipo: p.tipo, monto: p.monto })),
    },
    requestId,
    201
  );
}

export async function onRequest(context) {
  const { request, data } = context;
  const { requestId } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) {
    return Errors.methodNotAllowed(requestId);
  }
  return request.method === 'GET' ? handleList(context) : handleCreate(context);
}
