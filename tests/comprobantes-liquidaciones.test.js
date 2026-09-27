// Pruebas de comprobantes de LIQUIDACIÓN (conversión y transferencia) —
// RIO-116, segundo bloque. Cubre: dos documentos distintos que nunca se
// confunden, permisos (beneficiario propio, admin, "ser supervisor no
// concede acceso"), estado documental de la liquidación, rechazo con
// protección contra referenciar una versión ya reemplazada, y
// notificaciones internas idempotentes ante reintentos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as conversionComprobanteHandler } from '../functions/interno/api/comisiones/conversiones/[conversionId]/comprobante/index.js';
import { onRequest as conversionArchivoHandler } from '../functions/interno/api/comisiones/conversiones/[conversionId]/comprobante/[comprobanteId]/archivo.js';
import { onRequest as conversionRechazarHandler } from '../functions/interno/api/comisiones/conversiones/[conversionId]/comprobante/[comprobanteId]/index.js';
import { onRequest as transferenciaComprobanteHandler } from '../functions/interno/api/comisiones/liquidaciones/[liquidacionId]/comprobante-transferencia/index.js';
import { onRequest as transferenciaArchivoHandler } from '../functions/interno/api/comisiones/liquidaciones/[liquidacionId]/comprobante-transferencia/[comprobanteId]/archivo.js';
import { onRequest as transferenciaRechazarHandler } from '../functions/interno/api/comisiones/liquidaciones/[liquidacionId]/comprobante-transferencia/[comprobanteId]/index.js';
import { onRequest as estadoDocumentalHandler } from '../functions/interno/api/comisiones/liquidaciones/[liquidacionId]/estado-documental.js';
import { onRequest as notificacionesListHandler } from '../functions/interno/api/notificaciones/index.js';
import { onRequest as notificacionAccionHandler } from '../functions/interno/api/notificaciones/[notificacionId]/index.js';
import { onRequest as pagoHandler } from '../functions/interno/api/ventas/[id]/pagos/[pagoId]/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

const PDF_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
// Contenido DISTINTO al de PDF_BYTES (mismo header %PDF, distinto hash) —
// necesario porque guardarComprobante() ahora deduplica por hash real:
// dos subidas con el mismo contenido nunca crean una segunda versión
// (protección contra reintentos), así que una prueba que sí necesita una
// v2 real tiene que usar bytes efectivamente distintos, no solo un nombre
// de archivo distinto.
const PDF_BYTES_V2 = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01, 0x02];

function makeFile(bytes, name, type) {
  return new File([new Uint8Array(bytes)], name, { type });
}

function fakeR2() {
  const objetos = new Map();
  return {
    _objetos: objetos,
    put: async (key, buffer, opts) => { objetos.set(key, { buffer, contentType: opts?.httpMetadata?.contentType }); },
    get: async (key) => {
      const obj = objetos.get(key);
      if (!obj) return null;
      return { body: obj.buffer, httpMetadata: { contentType: obj.contentType } };
    },
    delete: async (key) => { objetos.delete(key); },
  };
}

const BENEFICIARIO = 'beneficiario@example.com';

function roleIdentity(overrides = {}) {
  return { email: BENEFICIARIO, role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}
function supervisorDelBeneficiario(overrides = {}) {
  return roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', allowedMarkets: ['CL'], canSell: false, permissions: PERMISSIONS.supervisor, ...overrides });
}
function otroEjecutivo(overrides = {}) {
  return roleIdentity({ email: 'otro.ejecutivo@example.com', ...overrides });
}
function asistenteAjeno(overrides = {}) {
  return roleIdentity({ email: 'practicante@example.com', role: 'asistente', canSell: false, permissions: PERMISSIONS.asistente, ...overrides });
}

function fakeDbLiquidaciones() {
  const state = {
    comisiones: [{ id: 'com-1', beneficiario_email: BENEFICIARIO, moneda: 'ARS' }],
    conversiones: [{ id: 'conv-1', comision_id: 'com-1' }],
    transferencias_comision: [{ id: 'liq-1', beneficiario_email: BENEFICIARIO }],
    transferencia_detalle: [{ id: 'det-1', transferencia_id: 'liq-1', comision_id: 'com-1', conversion_id: 'conv-1' }],
    comprobantes: [],
    notificaciones: [],
    eventos_historial: [],
  };
  function makeStatement(sql) {
    let p = [];
    return {
      bind(...params) { p = params; return this; },
      all: async () => ({ results: runSelect(sql, p) }),
      first: async () => runSelect(sql, p)[0] || null,
      run: async () => { runMutation(sql, p); return { success: true }; },
    };
  }
  function runSelect(sql, p) {
    if (sql.startsWith('SELECT modo_historico FROM ventas WHERE id')) return [];
    if (sql.includes('FROM conversiones conv JOIN comisiones com') && sql.includes('WHERE conv.id')) {
      const conv = state.conversiones.find((c) => c.id === p[0]);
      if (!conv) return [];
      const com = state.comisiones.find((c) => c.id === conv.comision_id);
      return [{ id: conv.id, comision_id: conv.comision_id, beneficiario_email: com?.beneficiario_email }];
    }
    if (sql.startsWith('SELECT id FROM conversiones WHERE id')) return state.conversiones.filter((c) => c.id === p[0]);
    if (sql.startsWith('SELECT id, beneficiario_email FROM transferencias_comision WHERE id')) {
      return state.transferencias_comision.filter((t) => t.id === p[0]);
    }
    if (sql.startsWith('SELECT id FROM transferencias_comision WHERE id')) return state.transferencias_comision.filter((t) => t.id === p[0]);
    if (sql.startsWith('SELECT id, version, hash_sha256, r2_key FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    if (sql.startsWith('SELECT * FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    if (sql.startsWith("SELECT * FROM comprobantes WHERE id = ? AND tipo = 'conversion' AND referencia_id")) {
      return state.comprobantes.filter((c) => c.id === p[0] && c.tipo === 'conversion' && c.referencia_id === p[1]);
    }
    if (sql.startsWith("SELECT * FROM comprobantes WHERE id = ? AND tipo = 'transferencia' AND referencia_id")) {
      return state.comprobantes.filter((c) => c.id === p[0] && c.tipo === 'transferencia' && c.referencia_id === p[1]);
    }
    if (sql.startsWith('SELECT DISTINCT conversion_id FROM transferencia_detalle WHERE transferencia_id')) {
      return state.transferencia_detalle.filter((d) => d.transferencia_id === p[0] && d.conversion_id).map((d) => ({ conversion_id: d.conversion_id }));
    }
    if (sql.startsWith('SELECT id FROM notificaciones WHERE clave_idempotencia')) {
      return state.notificaciones.filter((n) => n.clave_idempotencia === p[0]);
    }
    if (sql.startsWith("SELECT * FROM notificaciones WHERE destinatario_rol = 'admin' AND atendida_en IS NULL")) {
      return state.notificaciones.filter((n) => !n.atendida_en);
    }
    if (sql.startsWith("SELECT * FROM notificaciones WHERE destinatario_rol = 'admin' ORDER BY")) {
      return state.notificaciones;
    }
    if (sql.startsWith('SELECT id FROM notificaciones WHERE id')) return state.notificaciones.filter((n) => n.id === p[0]);
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith('UPDATE comprobantes SET vigente = 0')) {
      const c = state.comprobantes.find((x) => x.id === p[0]);
      if (c) c.vigente = 0;
    } else if (sql.startsWith('INSERT INTO comprobantes')) {
      state.comprobantes.push({
        id: p[0], tipo: p[1], referencia_id: p[2], venta_id: p[3], version: p[4], vigente: 1,
        r2_key: p[5], nombre_original: p[6], mime_type: p[7], tamano_bytes: p[8], hash_sha256: p[9], subido_por: p[10],
        rechazado_por: null, rechazado_en: null, motivo_rechazo: null,
      });
    } else if (sql.startsWith('UPDATE comprobantes SET rechazado_por')) {
      const c = state.comprobantes.find((x) => x.id === p[3]);
      if (c) { c.rechazado_por = p[0]; c.rechazado_en = p[1]; c.motivo_rechazo = p[2]; }
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0] });
    } else if (sql.startsWith('INSERT INTO notificaciones')) {
      state.notificaciones.push({
        id: p[0], tipo: p[1], clave_idempotencia: p[2], venta_id: p[3], pago_id: p[4], mercado: p[5],
        cliente_negocio: p[6], vendedor_email: p[7], ruta_portal: p[8], leida_en: null, leida_por: null, atendida_en: null, atendida_por: null,
      });
    } else if (sql.startsWith('UPDATE notificaciones SET leida_en')) {
      const n = state.notificaciones.find((x) => x.id === p[2] && !x.leida_en);
      if (n) { n.leida_en = p[0]; n.leida_por = p[1]; }
    } else if (sql.startsWith('UPDATE notificaciones SET atendida_en')) {
      const n = state.notificaciones.find((x) => x.id === p[2] && !x.atendida_en);
      if (n) { n.atendida_en = p[0]; n.atendida_por = p[1]; }
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }
  return {
    _state: state,
    prepare: (sql) => makeStatement(sql),
    batch: async (statements) => {
      if (state._failNextBatch) {
        state._failNextBatch = false;
        throw new Error('batch simulado: fallo de D1');
      }
      for (const stmt of statements) await stmt.run();
      return statements.map(() => ({ success: true }));
    },
  };
}

function fakeContext({ method = 'GET', roleIdentity: ri, db, bucket, params, formFile, body } = {}) {
  const init = { method };
  if (formFile) {
    const fd = new FormData();
    fd.append('archivo', formFile);
    init.body = fd;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/x', init),
    env: { DB: db, COMPROBANTES: bucket || fakeR2() },
    params,
    data: { requestId: 'req-liq-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

// --- Conversión: dos documentos distintos, nunca sustitutos ---

test('conversión: administración sube el comprobante de conversión, distinto del de transferencia', async () => {
  const db = fakeDbLiquidaciones();
  const bucket = fakeR2();
  const response = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'conversion.pdf', 'application/pdf') }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comprobantes.length, 1);
  assert.equal(db._state.comprobantes[0].tipo, 'conversion');
  assert.equal(db._state.comprobantes[0].referencia_id, 'conv-1');
});

test('transferencia: administración sube el comprobante de transferencia — queda como una fila SEPARADA de la de conversión', async () => {
  const db = fakeDbLiquidaciones();
  await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'conversion.pdf', 'application/pdf') }));
  const response = await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'transferencia.pdf', 'application/pdf') }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comprobantes.length, 2);
  const conversion = db._state.comprobantes.find((c) => c.tipo === 'conversion');
  const transferencia = db._state.comprobantes.find((c) => c.tipo === 'transferencia');
  assert.ok(conversion && transferencia, 'ambos tipos coexisten como documentos distintos');
  assert.notEqual(conversion.id, transferencia.id);
  assert.notEqual(conversion.referencia_id, transferencia.referencia_id);
});

test('conversión: una re-subida crea una versión 2 sin sobrescribir la 1', async () => {
  const db = fakeDbLiquidaciones();
  const bucket = fakeR2();
  const r1 = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'v1.pdf', 'application/pdf') }));
  const r2 = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES_V2, 'v2.pdf', 'application/pdf') }));
  assert.equal((await r1.json()).data.version, 1);
  assert.equal((await r2.json()).data.version, 2);
  assert.equal(db._state.comprobantes.length, 2);
  assert.equal(db._state.comprobantes.filter((c) => c.vigente === 1).length, 1);
});

// --- Permisos ---

test('conversión: el beneficiario de la comisión puede consultar (pero nunca subir) su comprobante', async () => {
  const db = fakeDbLiquidaciones();
  await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const consulta = await conversionComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db, params: { conversionId: 'conv-1' } }));
  assert.equal(consulta.status, 200);
  const subida = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  assert.equal(subida.status, 403, 'el beneficiario nunca sube, solo consulta y descarga');
});

test('conversión: un beneficiario intentando consultar la conversión de OTRA persona recibe 403', async () => {
  const db = fakeDbLiquidaciones();
  const response = await conversionComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: otroEjecutivo(), db, params: { conversionId: 'conv-1' } }));
  assert.equal(response.status, 403);
});

test('conversión: ser SUPERVISOR del beneficiario no concede ningún acceso — 403', async () => {
  const db = fakeDbLiquidaciones();
  const response = await conversionComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: supervisorDelBeneficiario(), db, params: { conversionId: 'conv-1' } }));
  assert.equal(response.status, 403);
});

test('conversión: un practicante/asistente sin relación recibe 403 — sin acceso a documentación financiera de liquidaciones', async () => {
  const db = fakeDbLiquidaciones();
  const response = await conversionComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: asistenteAjeno(), db, params: { conversionId: 'conv-1' } }));
  assert.equal(response.status, 403);
});

test('conversión: un conversionId inexistente (manipulación de ID) devuelve 404, no 403', async () => {
  const db = fakeDbLiquidaciones();
  const response = await conversionComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { conversionId: 'no-existe' } }));
  assert.equal(response.status, 404);
});

test('transferencia: el beneficiario de la liquidación puede consultar pero nunca subir', async () => {
  const db = fakeDbLiquidaciones();
  await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const consulta = await transferenciaComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal(consulta.status, 200);
  const subida = await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  assert.equal(subida.status, 403);
});

test('transferencia: un beneficiario ajeno recibe 403 al consultar la liquidación de otra persona', async () => {
  const db = fakeDbLiquidaciones();
  const response = await transferenciaComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: otroEjecutivo(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal(response.status, 403);
});

test('transferencia: ser supervisor del beneficiario tampoco concede acceso — 403', async () => {
  const db = fakeDbLiquidaciones();
  const response = await transferenciaComprobanteHandler(fakeContext({ method: 'GET', roleIdentity: supervisorDelBeneficiario(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal(response.status, 403);
});

// --- Descarga: cabeceras seguras ---

test('conversión: la descarga fuerza adjunto (nunca inline) y envía X-Content-Type-Options: nosniff', async () => {
  const db = fakeDbLiquidaciones();
  const bucket = fakeR2();
  const subida = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'comprobante conversion.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;

  const response = await conversionArchivoHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1', comprobanteId } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Cache-Control'), /no-store/);
});

test('transferencia: un supervisor recibe 403 al intentar descargar el archivo, aunque conozca el id del comprobante', async () => {
  const db = fakeDbLiquidaciones();
  const bucket = fakeR2();
  const subida = await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;
  const response = await transferenciaArchivoHandler(fakeContext({ method: 'GET', roleIdentity: supervisorDelBeneficiario(), db, bucket, params: { liquidacionId: 'liq-1', comprobanteId } }));
  assert.equal(response.status, 403);
});

test('archivo eliminado fuera de la aplicación (objeto ausente en R2, fila sigue en D1): 500 genérico, sin filtrar detalle interno', async () => {
  const db = fakeDbLiquidaciones();
  const bucketVacio = { get: async () => null };
  const bucketReal = fakeR2();
  const subida = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket: bucketReal, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;
  const response = await conversionArchivoHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, bucket: bucketVacio, params: { conversionId: 'conv-1', comprobanteId } }));
  assert.equal(response.status, 500);
  const raw = JSON.stringify(await response.json());
  assert.doesNotMatch(raw, /r2_key|_objetos/i);
});

test('comprobanteId inexistente/ajeno en la ruta de archivo: 404, nunca expone otro documento', async () => {
  const db = fakeDbLiquidaciones();
  const response = await conversionArchivoHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { conversionId: 'conv-1', comprobanteId: 'no-existe' } }));
  assert.equal(response.status, 404);
});

// --- Rechazo y reemplazo, con protección de versión vigente ---

test('rechazar: admin puede rechazar el comprobante de conversión vigente, con motivo obligatorio', async () => {
  const db = fakeDbLiquidaciones();
  const subida = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;

  const response = await conversionRechazarHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1', comprobanteId }, body: { action: 'rechazar', motivo: 'El tipo de cambio no coincide con la captura.' } }));
  assert.equal(response.status, 200);
  const c = db._state.comprobantes.find((x) => x.id === comprobanteId);
  assert.equal(c.rechazado_por, 'admin@example.com');
  assert.ok(c.motivo_rechazo);
  assert.equal(c.vigente, 1, 'sigue siendo el vigente — rechazado no es lo mismo que reemplazado');
});

test('rechazar: el beneficiario NO puede rechazar su propio comprobante (exclusivo de admin)', async () => {
  const db = fakeDbLiquidaciones();
  const subida = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;
  const response = await conversionRechazarHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, params: { conversionId: 'conv-1', comprobanteId }, body: { action: 'rechazar', motivo: 'x' } }));
  assert.equal(response.status, 403);
});

test('rechazar: sin motivo se rechaza con un error de validación', async () => {
  const db = fakeDbLiquidaciones();
  const subida = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;
  const response = await conversionRechazarHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1', comprobanteId }, body: { action: 'rechazar' } }));
  assert.equal(response.status, 400);
});

test('rechazar: referenciar una versión que ya fue reemplazada (manipulación de versión) se rechaza con un conflicto, nunca rechaza la vigente por error', async () => {
  const db = fakeDbLiquidaciones();
  const bucket = fakeR2();
  const v1 = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'v1.pdf', 'application/pdf') }));
  const { id: comprobanteV1Id } = (await v1.json()).data;
  await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES_V2, 'v2.pdf', 'application/pdf') }));

  const response = await conversionRechazarHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1', comprobanteId: comprobanteV1Id }, body: { action: 'rechazar', motivo: 'x' } }));
  assert.equal(response.status, 409, 'la v1 ya no es la vigente — nunca se rechaza la v2 "por las dudas"');
  const v2 = db._state.comprobantes.find((c) => c.vigente === 1);
  assert.equal(v2.rechazado_por, null, 'la versión vigente real nunca se ve afectada por una referencia equivocada');
});

test('rechazar: una re-subida después de un rechazo crea una versión nueva y limpia, conservando la anterior rechazada como historial', async () => {
  const db = fakeDbLiquidaciones();
  const bucket = fakeR2();
  const v1 = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'v1.pdf', 'application/pdf') }));
  const { id: comprobanteV1Id } = (await v1.json()).data;
  await conversionRechazarHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1', comprobanteId: comprobanteV1Id }, body: { action: 'rechazar', motivo: 'Monto ilegible' } }));

  const v2 = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, bucket, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES_V2, 'v2.pdf', 'application/pdf') }));
  assert.equal((await v2.json()).data.version, 2);

  const filaV1 = db._state.comprobantes.find((c) => c.id === comprobanteV1Id);
  const filaV2 = db._state.comprobantes.find((c) => c.vigente === 1);
  assert.equal(filaV1.rechazado_por, 'admin@example.com', 'la v1 conserva su historial de rechazo, nunca se borra');
  assert.equal(filaV2.rechazado_por, null, 'la v2 empieza limpia');
});

test('rechazar: un conversionId sin ningún comprobante todavía devuelve 404', async () => {
  const db = fakeDbLiquidaciones();
  const response = await conversionRechazarHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1', comprobanteId: 'lo-que-sea' }, body: { action: 'rechazar', motivo: 'x' } }));
  assert.equal(response.status, 404);
});

// --- Estado documental de la liquidación ---

test('estado documental: sin ningún comprobante subido, es "sin_comprobantes"', async () => {
  const db = fakeDbLiquidaciones();
  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.estadoDocumental, 'sin_comprobantes');
});

test('estado documental: con la conversión necesaria documentada pero sin transferencia, es "conversion_documentada"', async () => {
  const db = fakeDbLiquidaciones();
  await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal((await response.json()).data.estadoDocumental, 'conversion_documentada');
});

test('estado documental: con transferencia documentada pero sin la conversión necesaria, es "transferencia_documentada"', async () => {
  const db = fakeDbLiquidaciones();
  await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal((await response.json()).data.estadoDocumental, 'transferencia_documentada');
});

test('estado documental: con ambos documentados, es "documentacion_completa"', async () => {
  const db = fakeDbLiquidaciones();
  await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal((await response.json()).data.estadoDocumental, 'documentacion_completa');
});

test('estado documental: sin ninguna conversión requerida por esta liquidación, alcanza con la transferencia para "documentacion_completa"', async () => {
  const db = fakeDbLiquidaciones();
  db._state.transferencia_detalle[0].conversion_id = null; // esta liquidación no necesitó convertir nada.
  await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal((await response.json()).data.estadoDocumental, 'documentacion_completa');
});

test('estado documental: un documento rechazado prevalece como "rechazado_pendiente_reemplazo", aunque el otro esté completo', async () => {
  const db = fakeDbLiquidaciones();
  const subida = await conversionComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;
  await transferenciaComprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' }, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  await conversionRechazarHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { conversionId: 'conv-1', comprobanteId }, body: { action: 'rechazar', motivo: 'x' } }));

  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal((await response.json()).data.estadoDocumental, 'rechazado_pendiente_reemplazo');
});

test('estado documental: un beneficiario ajeno a la liquidación recibe 403', async () => {
  const db = fakeDbLiquidaciones();
  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: otroEjecutivo(), db, params: { liquidacionId: 'liq-1' } }));
  assert.equal(response.status, 403);
});

test('estado documental: una liquidación inexistente (manipulación de ID) devuelve 404', async () => {
  const db = fakeDbLiquidaciones();
  const response = await estadoDocumentalHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: { liquidacionId: 'no-existe' } }));
  assert.equal(response.status, 404);
});

// --- Notificaciones internas: idempotencia y flujo admin ---

test('notificaciones: informar un pago crea una notificación con mercado, cliente, vendedor y ruta al portal — nunca el archivo ni una URL pública', async () => {
  const db = fakeDbLiquidaciones();
  db._state.ventas = [{ id: 'venta-1', vendedor_email: BENEFICIARIO, mercado: 'CL' }];
  db._state.clientes = [{ id: 'cliente-1', negocio: 'Ferretería El Tornillo' }];
  db._state.ventas[0].cliente_id = 'cliente-1';
  db._state.pagos_esperados = [{ id: 'pago-x', venta_id: 'venta-1', estado: 'pendiente' }];
  db._state.pagos_informados = [];
  db._state.proyectos = [];
  db._state.componentes = [];

  // Extiende el fakeDb liviano con lo que necesita informarPago() + la
  // consulta de cliente para la notificación (no está en fakeDbLiquidaciones
  // por defecto, que está pensado para conversión/transferencia).
  const origAll = db.prepare;
  db.prepare = (sql) => {
    if (sql.startsWith('SELECT id, vendedor_email, mercado FROM ventas WHERE id')) {
      return { bind: (...p) => ({ all: async () => ({ results: db._state.ventas.filter((v) => v.id === p[0]) }) }) };
    }
    if (sql.startsWith('SELECT * FROM ventas WHERE id')) {
      return { bind: (...p) => ({ all: async () => ({ results: db._state.ventas.filter((v) => v.id === p[0]) }) }) };
    }
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) return { bind: () => ({ all: async () => ({ results: [] }) }) };
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) return { bind: () => ({ all: async () => ({ results: [] }) }) };
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) {
      return { bind: (...p) => ({ all: async () => ({ results: db._state.pagos_esperados.filter((x) => x.venta_id === p[0]) }) }) };
    }
    if (sql.startsWith('INSERT INTO pagos_informados')) {
      return { bind: (...p) => ({ run: async () => { db._state.pagos_informados.push({ id: p[0], pago_esperado_id: p[1] }); return { success: true }; } }) };
    }
    if (sql.startsWith("UPDATE pagos_esperados SET estado = 'informado'")) {
      return { bind: (...p) => ({ run: async () => { const pago = db._state.pagos_esperados.find((x) => x.id === p[0]); if (pago) pago.estado = 'informado'; return { success: true }; } }) };
    }
    if (sql.startsWith('INSERT INTO eventos_historial')) {
      return { bind: (...p) => ({ run: async () => { db._state.eventos_historial.push({ id: p[0] }); return { success: true }; } }) };
    }
    if (sql.includes('FROM ventas v JOIN clientes c') && sql.includes('WHERE v.id')) {
      return { bind: (...p) => ({ all: async () => { const v = db._state.ventas.find((x) => x.id === p[0]); const c = db._state.clientes.find((x) => x.id === v?.cliente_id); return { results: c ? [{ negocio: c.negocio }] : [] }; } }) };
    }
    return origAll(sql);
  };

  const ri = { email: BENEFICIARIO, role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo };
  const response = await pagoHandler({
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas/venta-1/pagos/pago-x', { method: 'POST', body: JSON.stringify({ action: 'informar', montoInformado: 1000 }), headers: { 'Content-Type': 'application/json' } }),
    env: { DB: db },
    params: { id: 'venta-1', pagoId: 'pago-x' },
    data: { requestId: 'req-notif', identity: { email: ri.email }, roleIdentity: ri },
  });
  assert.equal(response.status, 200);
  assert.equal(db._state.notificaciones.length, 1);
  const n = db._state.notificaciones[0];
  assert.equal(n.tipo, 'pago_informado');
  assert.equal(n.mercado, 'CL');
  assert.equal(n.cliente_negocio, 'Ferretería El Tornillo');
  assert.equal(n.vendedor_email, BENEFICIARIO);
  assert.ok(n.ruta_portal.startsWith('/interno/'));
  assert.doesNotMatch(n.ruta_portal, /^https?:\/\//, 'nunca una URL absoluta ni pública');
});

test('notificaciones: subir una nueva versión de comprobante de conversión NO crea una segunda notificación ante un reintento del mismo evento', async () => {
  const db = fakeDbLiquidaciones();
  // Simula dos intentos de "crear notificación" para el MISMO comprobante
  // (ej. un reintento de red) llamando directamente al helper compartido.
  const { crearNotificacionSiCorresponde } = await import('../functions/_shared/notificaciones.js');
  const id1 = await crearNotificacionSiCorresponde(db, 'req-a', {
    tipo: 'comprobante_nueva_version', claveIdempotencia: 'comprobante:abc', ventaId: null, pagoId: null,
    mercado: 'CL', clienteNegocio: null, vendedorEmail: BENEFICIARIO, rutaPortal: '/interno/index.html',
  });
  const id2 = await crearNotificacionSiCorresponde(db, 'req-b', {
    tipo: 'comprobante_nueva_version', claveIdempotencia: 'comprobante:abc', ventaId: null, pagoId: null,
    mercado: 'CL', clienteNegocio: null, vendedorEmail: BENEFICIARIO, rutaPortal: '/interno/index.html',
  });
  assert.equal(id1, id2, 'el segundo intento devuelve la MISMA notificación, nunca crea una nueva');
  assert.equal(db._state.notificaciones.length, 1);
});

test('notificaciones: admin puede listar, marcar leída y marcar atendida', async () => {
  const db = fakeDbLiquidaciones();
  const { crearNotificacionSiCorresponde } = await import('../functions/_shared/notificaciones.js');
  const notifId = await crearNotificacionSiCorresponde(db, 'req-c', {
    tipo: 'pago_informado', claveIdempotencia: 'pago_informado:xyz', ventaId: 'venta-1', pagoId: 'pago-x',
    mercado: 'CL', clienteNegocio: 'Cliente X', vendedorEmail: BENEFICIARIO, rutaPortal: '/interno/index.html?venta=venta-1',
  });

  const listado = await notificacionesListHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db, params: {} }));
  assert.equal(listado.status, 200);
  assert.equal((await listado.json()).data.notificaciones.length, 1);

  const leer = await notificacionAccionHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { notificacionId: notifId }, body: { action: 'leer' } }));
  assert.equal(leer.status, 200);
  assert.ok(db._state.notificaciones[0].leida_en);

  const atender = await notificacionAccionHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, params: { notificacionId: notifId }, body: { action: 'atender' } }));
  assert.equal(atender.status, 200);
  assert.ok(db._state.notificaciones[0].atendida_en);
  assert.equal(db._state.notificaciones[0].atendida_por, 'admin@example.com');
});

test('notificaciones: un ejecutivo (no admin) no puede listar notificaciones internas', async () => {
  const db = fakeDbLiquidaciones();
  const response = await notificacionesListHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db, params: {} }));
  assert.equal(response.status, 403);
});
