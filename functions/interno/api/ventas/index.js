// GET/POST /interno/api/ventas — RIO-112, permisos corregidos en RIO-113.
//
// GET: lista de ventas, con alcance según CAPACIDAD, no según el nombre del
// rol (Brenda, sección 1 de su corrección del 28/08/2026 — "no implementar
// reglas asociadas a nombres propios" aplica también a nombres de ROL):
//   - viewOthersData true/'sameMarketOnly' (admin/supervisor): las de sus
//     mercados autorizados (nunca "todas" sin condición).
//   - el resto (ejecutivo, asistente, o cualquier rol futuro sin esa
//     capacidad): solo las suyas (vendedor_email = su email) — la persona
//     vendedora no necesariamente es un Ejecutivo, así que esta rama ya no
//     depende de comparar `role === 'ejecutivo'`.
//
// POST: registra una venta y, en cascada y atómica (un solo db.batch()),
// su proyecto y 1-2 componentes según el producto. Requiere la capacidad
// `canSell` (independiente del rol — Brenda: "pueden vender: admin,
// supervisor, ejecutivo, asistente... si tiene la capacidad habilitada").
// Individual = 1 componente; pack = 2, con el precio distribuido
// proporcionalmente usando los precios individuales de referencia que
// viajan en la solicitud (ver functions/_shared/pricing.js sobre por qué
// no se importa markets.js acá).

import { ok, Errors } from '../../../_shared/response.js';
import { query, transaction } from '../../../_shared/db.js';
import { assertMarketAllowed, AuthzError } from '../../../_shared/authz.js';
import { isMethodAllowed, hasExpectedContentType, isBodyTooLarge } from '../../../_shared/security.js';
import { isValidPrice, splitPackPrice, CURRENCY_BY_MARKET } from '../../../_shared/pricing.js';
import { generarComisionesParaVenta, resolverEquipoVigenteDeVendedor } from '../../../_shared/comisiones.js';
import { agregarAntecedente } from '../../../_shared/proyectos.js';
import { intentarSincronizarHubSpot } from '../../../_shared/hubspot.js';

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

// RIO-117 (segundo bloque, 01/09/2026) — "En espera de pago" es un estado
// OPERATIVO calculado para mostrar, nunca una transición oficial nueva de
// `proyectos.estado_actual` (Brenda: "sin inventar una transición oficial
// del proyecto"). Se deriva pura y exclusivamente de datos que el
// servidor ya calculó (avance real del proyecto + si algún pago está
// acreditado + si existe una cancelación) — la única regla nueva acá es
// de PRESENTACIÓN, no de negocio: cuál de esos hechos ya conocidos se
// muestra como una sola etiqueta.
function calcularEstadoOperativo(row) {
  if ((row.cancelacion_count || 0) > 0) return 'cancelada';
  if (row.proyecto_estado === 'registrado' && (row.pagos_acreditados_count || 0) === 0) return 'en_espera_pago';
  return row.proyecto_estado || null;
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
    vendedorEmail: row.vendedor_email,
    equipoId: row.equipo_id || null,
    estadoActual: row.estado_actual,
    // RIO-117: ventas.estado_actual es un placeholder que nunca transiciona
    // (RIO-113 solo actualiza proyectos.estado_actual) — el avance real de
    // una venta para mostrar en un listado es el de su proyecto, no el de
    // la venta en sí. Nunca null salvo el caso imposible de una venta sin
    // proyecto (no ocurre: se crean juntos, en el mismo batch).
    proyectoEstado: row.proyecto_estado || null,
    estadoOperativo: calcularEstadoOperativo(row),
    // RIO-117 (corrección tras validación real, 01/09/2026): resúmenes
    // independientes para filtrar sin mezclar conceptos (Brenda, sección
    // 7) — "acreditado" solo si TODOS los pagos esperados lo están,
    // "completos" solo si TODOS los componentes lo están; con más de un
    // pago/componente, cualquier estado intermedio se muestra como
    // "informado"/"informados" (nunca se promedia ni se inventa un
    // tercer valor).
    estadoPagoResumen: row.estado_pago_resumen || 'pendiente',
    estadoMaterialesResumen: row.estado_materiales_resumen || 'pendiente',
    origen: row.origen || null,
    esDemo: !!row.es_demo,
    createdAt: row.created_at,
  };
}

// Reconstruye la MISMA forma de respuesta que devuelve una creación
// exitosa, a partir de una venta que ya existe — usado exclusivamente
// para el replay de idempotencia (RIO-117, segundo bloque): un reintento
// con la misma clave nunca vuelve a crear nada, solo devuelve lo que ya
// se creó la primera vez.
async function serializarVentaCompletaExistente(db, requestId, ventaId) {
  const ventaRows = await query(db, requestId, 'SELECT * FROM ventas WHERE id = ?', [ventaId]);
  const venta = ventaRows[0];
  if (!venta) return null;
  const proyectoRows = await query(db, requestId, 'SELECT * FROM proyectos WHERE venta_id = ?', [ventaId]);
  const proyecto = proyectoRows[0];
  if (!proyecto) return null;
  const componentes = await query(db, requestId, 'SELECT * FROM componentes WHERE proyecto_id = ? ORDER BY tipo', [proyecto.id]);
  const pagos = await query(db, requestId, 'SELECT * FROM pagos_esperados WHERE venta_id = ? ORDER BY tipo', [ventaId]);
  const hubspotRows = await query(db, requestId, 'SELECT estado, ultima_respuesta_resumen FROM hubspot_sync WHERE venta_id = ?', [ventaId]);

  return {
    venta: {
      id: venta.id,
      codigoVenta: venta.codigo_venta,
      mercado: venta.mercado,
      producto: venta.producto,
      moneda: venta.moneda,
      tipoPrecio: venta.tipo_precio,
      precioPactado: venta.precio_pactado,
      vendedorEmail: venta.vendedor_email,
      origen: venta.origen || null,
      esDemo: !!venta.es_demo,
      estadoOperativo: calcularEstadoOperativo({ proyecto_estado: proyecto.estado_actual, pagos_acreditados_count: pagos.filter((p) => p.estado === 'acreditado').length, cancelacion_count: 0 }),
    },
    proyecto: { id: proyecto.id, codigoProyecto: proyecto.codigo_proyecto },
    componentes: componentes.map((c) => ({ id: c.id, tipo: c.tipo, precioAtribuido: c.precio_atribuido, estadoActual: c.estado_actual })),
    pagosEsperados: pagos.map((p) => ({ tipo: p.tipo, monto: p.monto })),
    hubspotSync: hubspotRows[0] ? { estado: hubspotRows[0].estado, resumen: hubspotRows[0].ultima_respuesta_resumen } : null,
    replay: true,
  };
}

async function handleList(context) {
  const { env, data } = context;
  const { requestId, roleIdentity } = data;

  let rows;
  if (roleIdentity.permissions.viewOthersData) {
    // admin/supervisor (o cualquier capacidad futura equivalente):
    // limitado a sus propios mercados autorizados — nunca "todas las
    // ventas" sin condición (RIO-97 v2 sección 4).
    if (roleIdentity.allowedMarkets.length === 0) {
      return ok({ ventas: [] }, requestId);
    }
    const placeholders = roleIdentity.allowedMarkets.map(() => '?').join(',');
    rows = await query(
      env.DB,
      requestId,
      `SELECT v.*, c.negocio, p.estado_actual AS proyecto_estado,
         (SELECT COUNT(*) FROM pagos_esperados pe WHERE pe.venta_id = v.id AND pe.estado = 'acreditado') AS pagos_acreditados_count,
         (SELECT COUNT(*) FROM incidencias i WHERE i.venta_id = v.id AND i.tipo = 'cancelacion') AS cancelacion_count,
         (SELECT CASE WHEN COUNT(*) = 0 THEN 'pendiente'
            WHEN SUM(CASE WHEN pe.estado = 'acreditado' THEN 1 ELSE 0 END) = COUNT(*) THEN 'acreditado'
            WHEN SUM(CASE WHEN pe.estado IN ('informado', 'acreditado') THEN 1 ELSE 0 END) > 0 THEN 'informado'
            ELSE 'pendiente' END FROM pagos_esperados pe WHERE pe.venta_id = v.id) AS estado_pago_resumen,
         (SELECT CASE WHEN COUNT(*) = 0 THEN 'pendiente'
            WHEN SUM(CASE WHEN co.materiales_estado = 'completos' THEN 1 ELSE 0 END) = COUNT(*) THEN 'completos'
            WHEN SUM(CASE WHEN co.materiales_estado IN ('informados', 'completos') THEN 1 ELSE 0 END) > 0 THEN 'informados'
            ELSE 'pendiente' END FROM componentes co WHERE co.proyecto_id = p.id) AS estado_materiales_resumen
       FROM ventas v JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN proyectos p ON p.venta_id = v.id
       WHERE v.mercado IN (${placeholders}) ORDER BY v.created_at DESC`,
      roleIdentity.allowedMarkets
    );
  } else {
    // Sin capacidad de ver datos ajenos (ejecutivo, asistente, o
    // cualquier otro rol sin esa capacidad): solo sus propias ventas,
    // sin importar si figura como ejecutivo o no.
    rows = await query(
      env.DB,
      requestId,
      `SELECT v.*, c.negocio, p.estado_actual AS proyecto_estado,
         (SELECT COUNT(*) FROM pagos_esperados pe WHERE pe.venta_id = v.id AND pe.estado = 'acreditado') AS pagos_acreditados_count,
         (SELECT COUNT(*) FROM incidencias i WHERE i.venta_id = v.id AND i.tipo = 'cancelacion') AS cancelacion_count,
         (SELECT CASE WHEN COUNT(*) = 0 THEN 'pendiente'
            WHEN SUM(CASE WHEN pe.estado = 'acreditado' THEN 1 ELSE 0 END) = COUNT(*) THEN 'acreditado'
            WHEN SUM(CASE WHEN pe.estado IN ('informado', 'acreditado') THEN 1 ELSE 0 END) > 0 THEN 'informado'
            ELSE 'pendiente' END FROM pagos_esperados pe WHERE pe.venta_id = v.id) AS estado_pago_resumen,
         (SELECT CASE WHEN COUNT(*) = 0 THEN 'pendiente'
            WHEN SUM(CASE WHEN co.materiales_estado = 'completos' THEN 1 ELSE 0 END) = COUNT(*) THEN 'completos'
            WHEN SUM(CASE WHEN co.materiales_estado IN ('informados', 'completos') THEN 1 ELSE 0 END) > 0 THEN 'informados'
            ELSE 'pendiente' END FROM componentes co WHERE co.proyecto_id = p.id) AS estado_materiales_resumen
       FROM ventas v JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN proyectos p ON p.venta_id = v.id
       WHERE v.vendedor_email = ? ORDER BY v.created_at DESC`,
      [roleIdentity.email]
    );
  }

  return ok({ ventas: rows.map(serializeVenta) }, requestId);
}

async function handleCreate(context) {
  const { request, env, data } = context;
  const { requestId, roleIdentity } = data;

  if (!roleIdentity.canSell) {
    // La capacidad para vender es independiente del rol (Brenda, sección
    // 2): un ejecutivo sin can_sell tampoco puede vender, igual que un
    // admin/supervisor/asistente sin esa capacidad habilitada.
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

  // RIO-117 (segundo bloque): idempotencia — una sola acción de "Cerrar
  // venta" nunca crea dos ventas, sin importar clics repetidos, un
  // timeout de red, o una recarga de página con la misma clave guardada
  // en el cliente. La clave viaja en el header (o en el cuerpo, si el
  // cliente no puede setear headers custom) — si ya existe una venta con
  // esa clave, se devuelve el MISMO resultado de creación tal cual,
  // sin repetir ninguna escritura (ni D1 ni HubSpot).
  const idempotencyKey = request.headers.get('Idempotency-Key') || (body && body.idempotencyKey) || null;
  if (idempotencyKey) {
    const existentes = await query(env.DB, requestId, 'SELECT id FROM ventas WHERE idempotency_key = ?', [idempotencyKey]);
    if (existentes[0]) {
      const replay = await serializarVentaCompletaExistente(env.DB, requestId, existentes[0].id);
      if (replay) return ok(replay, requestId, 200);
      // La fila existe pero no se pudo reconstruir la respuesta completa
      // (inconsistencia real) — nunca se finge éxito ni se reintenta crear.
      return Errors.internal(requestId);
    }
  }

  const { mercado, cliente, producto, tipoPrecio, precioPactado, precioFichaIndividual, precioLandingIndividual, origen, esDemo, antecedentesKit, hubspot } = body || {};

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
      { id: crypto.randomUUID(), tipo: 'ficha', precioIndividualReferencia: precioFichaIndividual, precioAtribuido: split.precioFicha, estado: 'pendiente' },
      { id: crypto.randomUUID(), tipo: 'landing', precioIndividualReferencia: precioLandingIndividual, precioAtribuido: split.precioLanding, estado: 'bloqueada' },
    ];
  } else {
    const tipo = producto === 'ficha' ? 'ficha' : 'landing';
    componentesPlan = [
      { id: crypto.randomUUID(), tipo, precioIndividualReferencia: precioPactado, precioAtribuido: precioPactado, estado: 'pendiente' },
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

  // Marcar una venta como dato de demostración es exclusivo de admin —
  // nunca algo que un ejecutivo pueda activar sobre su propia venta real
  // (evita que quede fuera de la sincronización con HubSpot por error o
  // a propósito). Pensado para sembrar datos ficticios de Preview
  // (RIO-117), nunca para uso normal del Kit.
  if (esDemo && !roleIdentity.permissions.manageProduccionOficial) {
    return Errors.forbidden(requestId);
  }
  if (origen !== undefined && origen !== null && typeof origen !== 'string') {
    return Errors.validation('origen debe ser texto.', requestId);
  }
  if (antecedentesKit !== undefined && antecedentesKit !== null && (typeof antecedentesKit !== 'object' || Array.isArray(antecedentesKit))) {
    return Errors.validation('antecedentesKit debe ser un objeto.', requestId);
  }

  const db = env.DB;

  // RIO-115 (consolidación, Brenda 31/08/2026): equipo_id es una
  // fotografía inmutable del equipo vigente del vendedor AL MOMENTO DE
  // LA VENTA — se resuelve acá y nunca se recalcula después, para que un
  // cambio de equipo futuro no reescriba a quién le tocó supervisión en
  // ventas ya cerradas. Puede ser null (vendedor sin equipo asignado):
  // la venta igual se registra, pero no genera comisión de supervisión.
  const equipoId = await resolverEquipoVigenteDeVendedor(db, requestId, roleIdentity.email);

  const statements = [
    db.prepare('INSERT INTO clientes (id, negocio, contacto_nombre, telefono, email, mercado, datos_facturacion_ar, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(clienteId, cliente.negocio.trim(), cliente.contactoNombre || null, cliente.telefono || null, cliente.email || null, mercado, cliente.datosFacturacionAr || null, roleIdentity.email),
    db.prepare('INSERT INTO ventas (id, codigo_venta, cliente_id, mercado, producto, moneda, tipo_precio, precio_pactado, vendedor_email, equipo_id, idempotency_key, origen, es_demo, antecedentes_kit_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ventaId, codigoVenta, clienteId, mercado, producto, moneda, tipoPrecio, precioPactado, roleIdentity.email, equipoId, idempotencyKey, origen || null, esDemo ? 1 : 0, antecedentesKit ? JSON.stringify(antecedentesKit) : null),
    db.prepare('INSERT INTO proyectos (id, venta_id, codigo_proyecto) VALUES (?, ?, ?)')
      .bind(proyectoId, ventaId, codigoProyecto),
    ...componentesPlan.map((c) =>
      db.prepare('INSERT INTO componentes (id, proyecto_id, tipo, precio_individual_referencia, precio_atribuido, estado_actual) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(c.id, proyectoId, c.tipo, c.precioIndividualReferencia, c.precioAtribuido, c.estado)
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

  try {
    // RIO-114: comisión comercial (+ supervisión si corresponde) — nunca
    // condiciona la venta ya registrada. Si falla, la venta queda creada
    // igual (es una consecuencia contable, no un requisito para vender) y
    // el error queda solo en el log técnico.
    await generarComisionesParaVenta(db, requestId, {
      ventaId, vendedorEmail: roleIdentity.email, mercado, producto, moneda, equipoId,
      componentes: componentesPlan.map((c) => ({ id: c.id, precio_atribuido: c.precioAtribuido })),
    });
  } catch (e) {
    console.error(JSON.stringify({ requestId, scope: 'comisiones', reason: 'generacion_fallida' }));
  }

  // RIO-117 (corrección tras validación real, 01/09/2026): el historial
  // muestra una sola línea corta — el contenido completo (categorizado)
  // vive en antecedentes_kit_json, ya guardado arriba en el mismo batch,
  // y se sirve aparte, con permisos propios, en GET /ventas/:id (sección
  // plegable "Antecedentes del Kit"). Antes esto guardaba el texto
  // concatenado entero como motivo_nota del evento — Brenda: "el historial
  // no debe mostrar todas las respuestas del Kit como una cadena extensa".
  if (antecedentesKit) {
    try {
      await agregarAntecedente(db, requestId, { ventaId, nota: 'Venta registrada desde el Kit Comercial', actorEmail: roleIdentity.email });
    } catch (e) {
      console.error(JSON.stringify({ requestId, scope: 'antecedente', reason: 'registro_fallido' }));
    }
  }

  // RIO-117 (segundo bloque) / dependencia documentada con RIO-120: D1 ya
  // es la fuente de verdad operativa antes de este punto — la venta existe
  // sin importar lo que pase acá abajo. Los datos demo NUNCA se
  // sincronizan con HubSpot (Brenda, sección "Datos ficticios de
  // Preview"). Esto reutiliza el mismo endpoint público de Forms API que
  // el Kit ya llamaba desde el navegador — no es la integración segura
  // server-to-server de RIO-120 (todavía no iniciada), ver
  // functions/_shared/hubspot.js para el alcance exacto.
  let hubspotSync = null;
  if (!esDemo && hubspot && Array.isArray(hubspot.fields)) {
    hubspotSync = await intentarSincronizarHubSpot(db, requestId, { ventaId, fields: hubspot.fields, context: hubspot.context });
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
        vendedorEmail: roleIdentity.email,
        origen: origen || null,
        esDemo: !!esDemo,
        estadoOperativo: 'en_espera_pago',
      },
      proyecto: { id: proyectoId, codigoProyecto },
      componentes: componentesPlan.map((c) => ({ id: c.id, tipo: c.tipo, precioAtribuido: c.precioAtribuido, estadoActual: c.estado })),
      pagosEsperados: pagosPlan.map((p) => ({ tipo: p.tipo, monto: p.monto })),
      hubspotSync,
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
