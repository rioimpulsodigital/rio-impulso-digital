// Pruebas de functions/interno/api/ventas/* — RIO-112.
// Cubre en particular los requisitos de aislamiento: un ejecutivo no puede
// ver ventas de otro (ni cambiando el id en la ruta), y el alcance por
// mercado se respeta para admin/supervisor. Invoca los handlers con un
// `context` fabricado, igual que tests/identidad.test.js — la resolución
// de rol/mercado (RIO-111) ya se prueba aparte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as ventasHandler } from '../functions/interno/api/ventas/index.js';
import { onRequest as ventaDetailHandler } from '../functions/interno/api/ventas/[id].js';
import { PERMISSIONS } from '../functions/_shared/authz.js';
import { MARKETS } from '../interno/config/markets.js';

function roleIdentity(overrides = {}) {
  return {
    email: 'ejecutivo.a@example.com',
    nombre: 'Ejecutivo A',
    role: 'ejecutivo',
    allowedMarkets: ['CL'],
    defaultMarket: 'CL',
    userStatus: 'activo',
    canSell: true,
    permissions: PERMISSIONS.ejecutivo,
    ...overrides,
  };
}

// D1 simulado en memoria: soporta las sentencias reales que usan
// ventas/index.js y ventas/[id].js — INSERT vía batch() y los SELECT con
// join a clientes. No es un motor SQL real, pero respeta el mismo
// contrato prepare().bind().all()/.first() y batch() que usa el código.
function fakeDb(seed = { clientes: [], ventas: [], proyectos: [], componentes: [], pagos_esperados: [] }) {
  seed.pagos_esperados = seed.pagos_esperados || [];
  const state = seed;

  function makeStatement(sql) {
    let boundParams = [];
    return {
      bind(...p) {
        boundParams = p;
        return this;
      },
      _sql: sql,
      _params: () => boundParams,
      all: async () => ({ results: runSelect(sql, boundParams) }),
      first: async () => runSelect(sql, boundParams)[0] || null,
      run: async () => {
        runInsert(sql, boundParams);
        return { success: true };
      },
    };
  }

  function runInsert(sql, p) {
    if (sql.startsWith('INSERT INTO clientes')) {
      state.clientes.push({ id: p[0], negocio: p[1], contacto_nombre: p[2], telefono: p[3], email: p[4], mercado: p[5], datos_facturacion_ar: p[6], created_by: p[7] });
    } else if (sql.startsWith('INSERT INTO ventas')) {
      state.ventas.push({
        id: p[0], codigo_venta: p[1], cliente_id: p[2], mercado: p[3], producto: p[4], moneda: p[5],
        tipo_precio: p[6], precio_pactado: p[7], vendedor_email: p[8], estado_actual: 'registrada', created_at: '2026-08-28 00:00:00',
      });
    } else if (sql.startsWith('INSERT INTO proyectos')) {
      state.proyectos.push({ id: p[0], venta_id: p[1], codigo_proyecto: p[2], estado_actual: 'registrado' });
    } else if (sql.startsWith('INSERT INTO componentes')) {
      state.componentes.push({ id: p[0], proyecto_id: p[1], tipo: p[2], precio_individual_referencia: p[3], precio_atribuido: p[4], estado_actual: p[5], materiales_estado: 'pendiente' });
    } else if (sql.startsWith('INSERT INTO pagos_esperados')) {
      state.pagos_esperados.push({ id: p[0], venta_id: p[1], tipo: p[2], monto: p[3], moneda: p[4], estado: 'pendiente' });
    } else {
      throw new Error('INSERT inesperado en test: ' + sql);
    }
  }

  function runSelect(sql, p) {
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.vendedor_email')) {
      return state.ventas.filter((v) => v.vendedor_email === p[0]).map((v) => ({ ...v, negocio: state.clientes.find((c) => c.id === v.cliente_id)?.negocio }));
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.mercado IN')) {
      return state.ventas.filter((v) => p.includes(v.mercado)).map((v) => ({ ...v, negocio: state.clientes.find((c) => c.id === v.cliente_id)?.negocio }));
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.id = ?')) {
      const v = state.ventas.find((x) => x.id === p[0]);
      if (!v) return [];
      const c = state.clientes.find((x) => x.id === v.cliente_id);
      return [{ ...v, negocio: c?.negocio, contacto_nombre: c?.contacto_nombre, telefono: c?.telefono, cliente_email: c?.email, datos_facturacion_ar: c?.datos_facturacion_ar }];
    }
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) {
      return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    }
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) {
      return state.componentes.filter((c) => c.proyecto_id === p[0]);
    }
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) {
      return state.pagos_esperados.filter((pg) => pg.venta_id === p[0]);
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }

  return {
    prepare: (sql) => makeStatement(sql),
    batch: async (statements) => {
      for (const stmt of statements) {
        await stmt.run();
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

function fakeContext({ method = 'GET', url = 'https://rioimpulsodigital.com/interno/api/ventas', body, roleIdentity: ri, db, params = {} } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request(url, init),
    env: { DB: db },
    params,
    data: { requestId: 'req-ventas-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

const CL_INDIVIDUAL = { mercado: 'CL', cliente: { negocio: 'Ferretería El Tornillo' }, producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 50000 };
const CL_PACK = {
  mercado: 'CL', cliente: { negocio: 'Barbería Central' }, producto: 'ficha_generico', tipoPrecio: 'lanzamiento',
  precioPactado: 90000, precioFichaIndividual: 50000, precioLandingIndividual: 50000,
};

test('POST /ventas — crea una venta individual con un solo componente', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.venta.mercado, 'CL');
  assert.equal(body.data.componentes.length, 1);
  assert.equal(body.data.componentes[0].precioAtribuido, 50000);
  assert.equal(body.data.componentes[0].estadoActual, 'pendiente');
});

test('POST /ventas — crea un pack con dos componentes, precio distribuido y Landing bloqueada desde el inicio', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_PACK, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.componentes.length, 2);
  const ficha = body.data.componentes.find((c) => c.tipo === 'ficha');
  const landing = body.data.componentes.find((c) => c.tipo === 'landing');
  assert.equal(ficha.precioAtribuido + landing.precioAtribuido, 90000);
  assert.equal(ficha.estadoActual, 'pendiente');
  assert.equal(landing.estadoActual, 'bloqueada', 'la Landing nunca debe arrancar habilitada — flujo secuencial de Brenda');
});

test('POST /ventas — rechaza un precio que no corresponde a un precio vigente', async () => {
  const db = fakeDb();
  const ri = roleIdentity();
  const response = await ventasHandler(fakeContext({ method: 'POST', body: { ...CL_INDIVIDUAL, precioPactado: 1 }, roleIdentity: ri, db }));
  assert.equal(response.status, 400);
});

test('POST /ventas — rechaza un mercado fuera de allowedMarkets del ejecutivo', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ allowedMarkets: ['CL'] });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: { ...CL_PACK, mercado: 'AR' }, roleIdentity: ri, db }));
  assert.equal(response.status, 403);
});

test('POST /ventas — un asistente sin can_sell no puede registrar ventas', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ role: 'asistente', permissions: PERMISSIONS.asistente, canSell: false });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 403);
});

test('POST /ventas — un asistente CON can_sell sí puede registrar una venta propia (capacidad, no rol)', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ role: 'asistente', permissions: PERMISSIONS.asistente, canSell: true, email: 'practicante@example.com' });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 201);
});

test('POST /ventas — un ejecutivo SIN can_sell no puede registrar ventas (la capacidad no depende del rol)', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ canSell: false });
  const response = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(response.status, 403);
});

test('GET /ventas — un ejecutivo solo ve sus propias ventas, nunca las de otro (aislamiento)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const b = roleIdentity({ email: 'ejecutivo.b@example.com' });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  await ventasHandler(fakeContext({ method: 'POST', body: { ...CL_INDIVIDUAL, cliente: { negocio: 'Otro negocio' } }, roleIdentity: b, db }));

  const responseA = await ventasHandler(fakeContext({ roleIdentity: a, db }));
  const bodyA = await responseA.json();
  assert.equal(bodyA.data.ventas.length, 1);
  assert.equal(bodyA.data.ventas[0].vendedorEmail, 'ejecutivo.a@example.com');

  const responseB = await ventasHandler(fakeContext({ roleIdentity: b, db }));
  const bodyB = await responseB.json();
  assert.equal(bodyB.data.ventas.length, 1);
  assert.equal(bodyB.data.ventas[0].vendedorEmail, 'ejecutivo.b@example.com');
});

test('GET /ventas — un admin/supervisor solo ve ventas de SUS mercados autorizados, no de otros', async () => {
  const db = fakeDb();
  const ejecutivoCl = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const ejecutivoAr = roleIdentity({ email: 'ejecutivo.ar@example.com', allowedMarkets: ['AR'] });
  await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ejecutivoCl, db }));
  await ventasHandler(fakeContext({
    method: 'POST',
    body: { mercado: 'AR', cliente: { negocio: 'Estudio Uñas' }, producto: 'ficha', tipoPrecio: 'lanzamiento', precioPactado: 125000 },
    roleIdentity: ejecutivoAr, db,
  }));

  const supervisorCl = roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  const responseCl = await ventasHandler(fakeContext({ roleIdentity: supervisorCl, db }));
  const bodyCl = await responseCl.json();
  assert.equal(bodyCl.data.ventas.length, 1);
  assert.equal(bodyCl.data.ventas[0].mercado, 'CL');

  const adminAmbos = roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const responseAmbos = await ventasHandler(fakeContext({ roleIdentity: adminAmbos, db }));
  const bodyAmbos = await responseAmbos.json();
  assert.equal(bodyAmbos.data.ventas.length, 2);
});

test('GET /ventas — un asistente puede listar (solo ve las suyas, igual que un ejecutivo — la capacidad de ver ajenas nunca depende del nombre del rol)', async () => {
  const db = fakeDb();
  const ri = roleIdentity({ email: 'practicante@example.com', role: 'asistente', permissions: PERMISSIONS.asistente, canSell: true });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: ri, db }));
  assert.equal(createResponse.status, 201);
  const response = await ventasHandler(fakeContext({ roleIdentity: ri, db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.ventas.length, 1);
  assert.equal(body.data.ventas[0].vendedorEmail, 'practicante@example.com');
});

test('GET /ventas/:id — un ejecutivo NO puede ver la venta de otro ejecutivo cambiando el id en la ruta (403/404, nunca los datos)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const b = roleIdentity({ email: 'ejecutivo.b@example.com' });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  // B intenta acceder a la venta de A cambiando el id en la ruta.
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: b, db, params: { id: created.id } }));
  assert.equal(response.status, 404, 'debe comportarse igual que "no existe" — nunca confirmar que la venta existe pero es ajena');
  const raw = JSON.stringify(await response.json());
  assert.doesNotMatch(raw, /Ferretería/); // el negocio del cliente de A no debe filtrarse.
});

test('GET /ventas/:id — el dueño de la venta sí puede verla', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: a, db, params: { id: created.id } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.venta.id, created.id);
  assert.equal(body.data.componentes.length, 1);
});

test('GET /ventas/:id — un supervisor de OTRO mercado no puede ver la venta (aislamiento entre mercados)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  const supervisorAr = roleIdentity({ email: 'supervisor.ar@example.com', role: 'supervisor', allowedMarkets: ['AR'], permissions: PERMISSIONS.supervisor });
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: supervisorAr, db, params: { id: created.id } }));
  assert.equal(response.status, 404);
});

test('GET /ventas/:id — un supervisor del MISMO mercado sí puede ver la venta', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.cl@example.com', allowedMarkets: ['CL'] });
  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  const created = (await createResponse.json()).data.venta;

  const supervisorCl = roleIdentity({ email: 'supervisor.cl@example.com', role: 'supervisor', allowedMarkets: ['CL'], permissions: PERMISSIONS.supervisor });
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: supervisorCl, db, params: { id: created.id } }));
  assert.equal(response.status, 200);
});

test('GET /ventas/:id — id inexistente devuelve 404 igual para cualquier rol', async () => {
  const db = fakeDb();
  const admin = roleIdentity({ role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin });
  const response = await ventaDetailHandler(fakeContext({ roleIdentity: admin, db, params: { id: 'no-existe' } }));
  assert.equal(response.status, 404);
});

test('método no permitido en /ventas (DELETE) — 405', async () => {
  const db = fakeDb();
  const response = await ventasHandler(fakeContext({ method: 'DELETE', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 405);
});

test('un cambio posterior en el precio canónico (markets.js) NO altera una venta ya registrada (snapshot inmutable)', async () => {
  const db = fakeDb();
  const a = roleIdentity({ email: 'ejecutivo.a@example.com' });
  const precioOriginal = MARKETS.CL.products.ficha.promo;

  const createResponse = await ventasHandler(fakeContext({ method: 'POST', body: CL_INDIVIDUAL, roleIdentity: a, db }));
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).data.venta;
  assert.equal(created.precioPactado, precioOriginal);

  // Simula que el precio canónico cambió después de registrada la venta
  // (ej. una nueva campaña) — mutamos el mismo objeto MARKETS importado
  // que usa pricing.js, sin tocar la venta ya guardada.
  const backup = MARKETS.CL.products.ficha.promo;
  MARKETS.CL.products.ficha.promo = precioOriginal + 12345;
  try {
    const detailResponse = await ventaDetailHandler(fakeContext({ roleIdentity: a, db, params: { id: created.id } }));
    const detailBody = await detailResponse.json();
    assert.equal(detailBody.data.venta.precioPactado, precioOriginal, 'la venta histórica debe conservar el precio con el que se pactó, no el nuevo precio canónico');
    assert.notEqual(detailBody.data.venta.precioPactado, MARKETS.CL.products.ficha.promo);
  } finally {
    MARKETS.CL.products.ficha.promo = backup; // no contaminar otras pruebas.
  }
});
