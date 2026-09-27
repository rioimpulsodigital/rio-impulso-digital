// Pruebas de functions/_shared/comprobantes.js y de las rutas de
// comprobante — RIO-116 (Brenda, decisiones confirmadas 28/08 y
// consolidadas 31/08/2026): validación de archivo (extensión + MIME +
// firma real), versionado sin sobrescritura, y el control de acceso
// deliberadamente más estricto que el resto del sistema (el supervisor
// NUNCA ve el comprobante bancario ajeno, aunque sí vea la venta).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarComprobante, guardarComprobante, obtenerComprobanteVigente, rechazarComprobante, ArchivoError, ComprobanteError, MAX_COMPROBANTE_BYTES } from '../functions/_shared/comprobantes.js';
import { onRequest as comprobanteHandler } from '../functions/interno/api/ventas/[id]/pagos/[pagoId]/comprobante/index.js';
import { onRequest as archivoHandler } from '../functions/interno/api/ventas/[id]/pagos/[pagoId]/comprobante/[comprobanteId]/archivo.js';
import { onRequest as pagoHandler } from '../functions/interno/api/ventas/[id]/pagos/[pagoId]/index.js';
import { PERMISSIONS } from '../functions/_shared/authz.js';

const PDF_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46];
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];

function makeFile(bytes, name, type) {
  return new File([new Uint8Array(bytes)], name, { type });
}

// --- validarComprobante() ---

test('validarComprobante() — acepta un PDF real con extensión y MIME consistentes', async () => {
  const resultado = await validarComprobante(makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf'));
  assert.equal(resultado.mimeType, 'application/pdf');
  assert.equal(resultado.tamanoBytes, PDF_BYTES.length);
  assert.equal(resultado.hashSha256.length, 64);
});

test('validarComprobante() — acepta JPG y PNG reales', async () => {
  const jpg = await validarComprobante(makeFile(JPEG_BYTES, 'foto.jpg', 'image/jpeg'));
  assert.equal(jpg.mimeType, 'image/jpeg');
  const png = await validarComprobante(makeFile(PNG_BYTES, 'foto.png', 'image/png'));
  assert.equal(png.mimeType, 'image/png');
});

test('validarComprobante() — rechaza una extensión no permitida (SVG) sin necesidad de una blocklist explícita', async () => {
  await assert.rejects(
    () => validarComprobante(makeFile([0x3c, 0x73, 0x76, 0x67], 'imagen.svg', 'image/svg+xml')),
    (e) => { assert.ok(e instanceof ArchivoError); assert.equal(e.code, 'extension_no_permitida'); return true; }
  );
});

test('validarComprobante() — rechaza HTML disfrazado de PDF (extensión .pdf, contenido HTML real)', async () => {
  const html = Array.from(Buffer.from('<html><body>hola</body></html>'));
  await assert.rejects(
    () => validarComprobante(makeFile(html, 'no-es-un-pdf.pdf', 'application/pdf')),
    (e) => { assert.equal(e.code, 'firma_no_reconocida'); return true; }
  );
});

test('validarComprobante() — rechaza un ejecutable renombrado a .png (firma MZ, extensión .png)', async () => {
  const exe = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00];
  await assert.rejects(
    () => validarComprobante(makeFile(exe, 'captura.png', 'image/png')),
    (e) => { assert.equal(e.code, 'firma_no_reconocida'); return true; }
  );
});

test('validarComprobante() — rechaza cuando la extensión no coincide con la firma real (un PNG renombrado a .pdf)', async () => {
  await assert.rejects(
    () => validarComprobante(makeFile(PNG_BYTES, 'comprobante.pdf', 'application/pdf')),
    (e) => { assert.equal(e.code, 'extension_no_coincide'); return true; }
  );
});

test('validarComprobante() — rechaza cuando el MIME declarado no coincide con la firma real, aunque la extensión sí', async () => {
  await assert.rejects(
    () => validarComprobante(makeFile(PDF_BYTES, 'comprobante.pdf', 'image/png')),
    (e) => { assert.equal(e.code, 'mime_no_coincide'); return true; }
  );
});

test('validarComprobante() — rechaza un archivo más grande que el límite de 10 MB', async () => {
  const grande = new Array(MAX_COMPROBANTE_BYTES + 1).fill(0);
  grande[0] = 0x25; grande[1] = 0x50; grande[2] = 0x44; grande[3] = 0x46; // firma PDF válida, solo el tamaño falla.
  await assert.rejects(
    () => validarComprobante(makeFile(grande, 'grande.pdf', 'application/pdf')),
    (e) => { assert.equal(e.code, 'archivo_demasiado_grande'); return true; }
  );
});

test('validarComprobante() — rechaza un archivo vacío', async () => {
  await assert.rejects(
    () => validarComprobante(makeFile([], 'vacio.pdf', 'application/pdf')),
    (e) => { assert.equal(e.code, 'archivo_vacio'); return true; }
  );
});

// --- guardarComprobante() / versionado ---

function fakeR2({ failPut = false, failDelete = false } = {}) {
  const objetos = new Map();
  return {
    _objetos: objetos,
    put: async (key, buffer, opts) => {
      if (failPut) throw new Error('put simulado: fallo de R2');
      objetos.set(key, { buffer, contentType: opts?.httpMetadata?.contentType });
    },
    get: async (key) => {
      const obj = objetos.get(key);
      if (!obj) return null;
      return { body: obj.buffer, httpMetadata: { contentType: obj.contentType } };
    },
    delete: async (key) => {
      if (failDelete) throw new Error('delete simulado: fallo de R2');
      objetos.delete(key);
    },
  };
}

function fakeDbComprobantes() {
  const state = { comprobantes: [], eventos_historial: [] };
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
    if (sql.startsWith('SELECT id, version, hash_sha256, r2_key FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    if (sql.startsWith('SELECT * FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith('UPDATE comprobantes SET vigente = 0')) {
      const c = state.comprobantes.find((x) => x.id === p[0]);
      if (c) c.vigente = 0;
    } else if (sql.startsWith('UPDATE comprobantes SET rechazado_por')) {
      const c = state.comprobantes.find((x) => x.id === p[3]);
      if (c) { c.rechazado_por = p[0]; c.rechazado_en = p[1]; c.motivo_rechazo = p[2]; }
    } else if (sql.startsWith('INSERT INTO comprobantes')) {
      state.comprobantes.push({
        id: p[0], tipo: p[1], referencia_id: p[2], venta_id: p[3], version: p[4], vigente: 1,
        r2_key: p[5], nombre_original: p[6], mime_type: p[7], tamano_bytes: p[8], hash_sha256: p[9], subido_por: p[10],
        rechazado_por: null, rechazado_en: null, motivo_rechazo: null,
      });
    } else if (sql.includes("INSERT INTO eventos_historial") && sql.includes("'comprobante'")) {
      // Insert embebido de guardarComprobante() — entidad va literal en el SQL, no bindeada.
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: 'comprobante', entidad_id: p[2], estado_anterior: p[3], estado_nuevo: p[4], usuario_email: p[5] });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6], motivo_nota: p[7] });
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

test('guardarComprobante() — la primera subida crea la versión 1, vigente', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const archivo = await validarComprobante(makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf'));
  const { id, version } = await guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-1', ventaId: 'v1', archivo, subidoPor: 'vendedor@example.com' });
  assert.equal(version, 1);
  assert.equal(db._state.comprobantes.length, 1);
  assert.equal(db._state.comprobantes[0].vigente, 1);
  assert.ok(bucket._objetos.has(db._state.comprobantes[0].r2_key));
});

test('guardarComprobante() — una re-subida crea la versión 2 y NUNCA sobrescribe ni borra la versión 1 (ni la fila ni el objeto R2)', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const archivo1 = await validarComprobante(makeFile(PDF_BYTES, 'comprobante-v1.pdf', 'application/pdf'));
  const primera = await guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-1', ventaId: 'v1', archivo: archivo1, subidoPor: 'vendedor@example.com' });

  const archivo2 = await validarComprobante(makeFile(JPEG_BYTES, 'comprobante-v2.jpg', 'image/jpeg'));
  const segunda = await guardarComprobante(db, bucket, 'req-2', { tipo: 'pago', referenciaId: 'pi-1', ventaId: 'v1', archivo: archivo2, subidoPor: 'admin@example.com' });

  assert.equal(segunda.version, 2);
  assert.equal(db._state.comprobantes.length, 2, 'nunca se borra la fila anterior');
  const v1 = db._state.comprobantes.find((c) => c.id === primera.id);
  const v2 = db._state.comprobantes.find((c) => c.id === segunda.id);
  assert.equal(v1.vigente, 0, 'la versión anterior deja de ser vigente, pero sigue existiendo');
  assert.equal(v2.vigente, 1);
  assert.ok(bucket._objetos.has(v1.r2_key), 'el objeto R2 de la versión 1 nunca se borra');
  assert.ok(bucket._objetos.has(v2.r2_key));
  assert.notEqual(v1.r2_key, v2.r2_key, 'cada versión tiene su propia clave — nunca se pisan');

  const vigente = await obtenerComprobanteVigente(db, 'req-3', { tipo: 'pago', referenciaId: 'pi-1' });
  assert.equal(vigente.id, segunda.id);
});

test('guardarComprobante() — un reintento con el MISMO contenido (mismo hash) no duplica el archivo ni crea una versión nueva', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const archivo = await validarComprobante(makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf'));
  const primero = await guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-1', ventaId: 'v1', archivo, subidoPor: 'vendedor@example.com' });

  // Simula un reintento de red: se vuelve a validar y subir EXACTAMENTE el mismo archivo.
  const archivoReintento = await validarComprobante(makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf'));
  const reintento = await guardarComprobante(db, bucket, 'req-2', { tipo: 'pago', referenciaId: 'pi-1', ventaId: 'v1', archivo: archivoReintento, subidoPor: 'vendedor@example.com' });

  assert.equal(reintento.id, primero.id, 'devuelve la misma versión, nunca crea una segunda');
  assert.equal(reintento.version, 1);
  assert.equal(db._state.comprobantes.length, 1, 'ninguna fila nueva');
  assert.equal(bucket._objetos.size, 1, 'ningún objeto R2 nuevo');
});

test('nuevaClaveR2 — la clave nunca incluye el nombre aportado por el usuario, y no es predecible entre dos subidas del mismo contenido', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const nombrePeligroso = '../../etc/passwd o "cualquier cosa"\ncon saltos de línea.pdf';
  const archivo = await validarComprobante(makeFile(PDF_BYTES, nombrePeligroso, 'application/pdf'));
  const { r2Key } = await guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-2', ventaId: 'v1', archivo, subidoPor: 'vendedor@example.com' });

  assert.doesNotMatch(r2Key, /etc|passwd|\.\.|"|\n/, 'la clave física en R2 nunca deriva del nombre del archivo');
  assert.doesNotMatch(archivo.nombreOriginal, /[\r\n"\\/]/, 'el nombre VISIBLE queda saneado (sin saltos de línea, comillas ni separadores de ruta)');

  // Dos subidas de contenido idéntico a referencias DISTINTAS deben tener
  // claves distintas — no hay forma de adivinar una a partir de la otra.
  const archivo2 = await validarComprobante(makeFile(PDF_BYTES, 'otro.pdf', 'application/pdf'));
  const { r2Key: r2Key2 } = await guardarComprobante(db, bucket, 'req-2', { tipo: 'pago', referenciaId: 'pi-3', ventaId: 'v1', archivo: archivo2, subidoPor: 'vendedor@example.com' });
  assert.notEqual(r2Key, r2Key2);
});

// --- Consistencia R2 <-> D1 ante fallas parciales (RIO-116, verificación
// final, Brenda 31/08/2026) — NUNCA una transacción real entre los dos
// sistemas (Cloudflare no la ofrece); el mecanismo real es: R2 primero,
// D1 después en una sola transacción, y una compensación best-effort si
// D1 falla después de que R2 ya tiene el objeto. Estas pruebas verifican
// ESE mecanismo real, no una atomicidad que no existe. ---

test('consistencia: si la escritura en R2 falla, NO se crea ninguna fila en D1 (nunca una versión que apunte a un objeto inexistente)', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2({ failPut: true });
  const archivo = await validarComprobante(makeFile(PDF_BYTES, 'x.pdf', 'application/pdf'));

  await assert.rejects(
    () => guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-r2fail', ventaId: 'v1', archivo, subidoPor: 'vendedor@example.com' }),
    (e) => { assert.ok(e instanceof ComprobanteError); assert.equal(e.code, 'r2_put_fallido'); return true; }
  );
  assert.equal(db._state.comprobantes.length, 0, 'ninguna fila en D1 — nunca queda una versión "utilizable" sin objeto real detrás');
});

test('consistencia: si D1 falla DESPUÉS de que R2 ya recibió el objeto, se compensa borrando el objeto recién subido — nunca queda invisible sin rastro', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const archivo = await validarComprobante(makeFile(PDF_BYTES, 'x.pdf', 'application/pdf'));
  db._state._failNextBatch = true;

  await assert.rejects(
    () => guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-d1fail', ventaId: 'v1', archivo, subidoPor: 'vendedor@example.com' }),
    (e) => { assert.ok(e instanceof ComprobanteError); assert.equal(e.code, 'registro_fallido'); return true; }
  );
  assert.equal(db._state.comprobantes.length, 0, 'no queda ninguna fila a medio insertar');
  assert.equal(bucket._objetos.size, 0, 'el objeto recién subido se compensa (se borra) — no queda huérfano en R2 cuando la compensación puede completarse');
});

test('consistencia: si D1 falla Y la compensación en R2 también falla, la función igual reporta el error (nunca finge éxito) — el objeto huérfano queda documentado por el log, no perdido en silencio', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2({ failDelete: true });
  const archivo = await validarComprobante(makeFile(PDF_BYTES, 'x.pdf', 'application/pdf'));
  db._state._failNextBatch = true;

  await assert.rejects(
    () => guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-doblefallo', ventaId: 'v1', archivo, subidoPor: 'vendedor@example.com' }),
    (e) => { assert.ok(e instanceof ComprobanteError); assert.equal(e.code, 'registro_fallido'); return true; }
  );
  assert.equal(db._state.comprobantes.length, 0, 'D1 sigue sin ninguna fila — el estado que el sistema puede consultar nunca miente');
});

test('consistencia: si la transacción de D1 falla al reemplazar una versión existente, la versión ANTERIOR sigue siendo la vigente (nunca queda "sin ninguna vigente" a mitad de camino)', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const archivoV1 = await validarComprobante(makeFile(PDF_BYTES, 'v1.pdf', 'application/pdf'));
  const primera = await guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-parcial', ventaId: 'v1', archivo: archivoV1, subidoPor: 'vendedor@example.com' });

  const archivoV2 = await validarComprobante(makeFile(JPEG_BYTES, 'v2.jpg', 'image/jpeg'));
  db._state._failNextBatch = true;
  await assert.rejects(() => guardarComprobante(db, bucket, 'req-2', { tipo: 'pago', referenciaId: 'pi-parcial', ventaId: 'v1', archivo: archivoV2, subidoPor: 'vendedor@example.com' }));

  const vigente = await obtenerComprobanteVigente(db, 'req-3', { tipo: 'pago', referenciaId: 'pi-parcial' });
  assert.ok(vigente, 'debe seguir habiendo UNA vigente — el UPDATE que la marcaba no-vigente y el INSERT de la nueva son la misma transacción, así que si una falla, la otra también se revierte');
  assert.equal(vigente.id, primera.id, 'la vigente sigue siendo la v1 original, intacta');
});

test('consistencia: un reintento con el mismo archivo después de que la notificación falló no duplica el comprobante (recupera el estado correcto por idempotencia, sin versión ficticia)', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const archivo = await validarComprobante(makeFile(PDF_BYTES, 'x.pdf', 'application/pdf'));
  const primero = await guardarComprobante(db, bucket, 'req-1', { tipo: 'pago', referenciaId: 'pi-notif', ventaId: 'v1', archivo, subidoPor: 'vendedor@example.com' });
  // La notificación posterior (fuera de guardarComprobante) falla — el
  // cliente reintenta la SOLICITUD COMPLETA, revalidando y resubiendo el
  // mismo archivo.
  const archivoReintento = await validarComprobante(makeFile(PDF_BYTES, 'x.pdf', 'application/pdf'));
  const reintento = await guardarComprobante(db, bucket, 'req-2', { tipo: 'pago', referenciaId: 'pi-notif', ventaId: 'v1', archivo: archivoReintento, subidoPor: 'vendedor@example.com' });

  assert.equal(reintento.id, primero.id);
  assert.equal(reintento.version, 1, 'nunca crea una versión 2 ficticia solo porque la notificación falló');
  assert.equal(db._state.comprobantes.length, 1);
});

test('rechazarComprobante() — expone el mecanismo real de rechazo sin borrar el archivo ni el registro subyacente', async () => {
  const db = fakeDbComprobantes();
  const bucket = fakeR2();
  const archivo = await validarComprobante(makeFile(PDF_BYTES, 'x.pdf', 'application/pdf'));
  const { id } = await guardarComprobante(db, bucket, 'req-1', { tipo: 'conversion', referenciaId: 'conv-x', ventaId: null, archivo, subidoPor: 'vendedor@example.com' });

  await rechazarComprobante(db, 'req-2', { tipo: 'conversion', referenciaId: 'conv-x', motivo: 'Monto ilegible', actorEmail: 'admin@example.com' });
  const vigente = await obtenerComprobanteVigente(db, 'req-3', { tipo: 'conversion', referenciaId: 'conv-x' });
  assert.equal(vigente.id, id, 'sigue siendo la misma fila — rechazar no reemplaza ni borra nada');
  assert.equal(vigente.rechazado_por, 'admin@example.com');
  assert.ok(vigente.rechazado_en);
  assert.equal(vigente.motivo_rechazo, 'Monto ilegible');
  assert.ok(bucket._objetos.has(vigente.r2_key), 'el objeto real en R2 nunca se toca al rechazar');
});

// --- Rutas: control de acceso ---

const VENDEDOR = 'vendedor.a@example.com';

function roleIdentity(overrides = {}) {
  return { email: VENDEDOR, role: 'ejecutivo', allowedMarkets: ['CL'], canSell: true, permissions: PERMISSIONS.ejecutivo, ...overrides };
}
function admin(overrides = {}) {
  return roleIdentity({ email: 'admin@example.com', role: 'admin', allowedMarkets: ['CL', 'AR'], permissions: PERMISSIONS.admin, ...overrides });
}
function supervisorMismoMercado(overrides = {}) {
  return roleIdentity({ email: 'supervisor@example.com', role: 'supervisor', allowedMarkets: ['CL'], canSell: false, permissions: PERMISSIONS.supervisor, ...overrides });
}

function fakeDbRuta({ pagoEstado = 'informado', conInformado = true } = {}) {
  const state = {
    ventas: [{ id: 'venta-1', vendedor_email: VENDEDOR, mercado: 'CL' }],
    pagos_esperados: [{ id: 'pago-x', venta_id: 'venta-1', estado: pagoEstado }],
    pagos_informados: conInformado ? [{ id: 'pi-1', pago_esperado_id: 'pago-x', created_at: '2026-08-31 00:00:00' }] : [],
    comprobantes: [],
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
    if (sql.startsWith('SELECT id, vendedor_email, mercado FROM ventas')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT id, estado FROM pagos_esperados WHERE id = ? AND venta_id')) {
      return state.pagos_esperados.filter((x) => x.id === p[0] && x.venta_id === p[1]);
    }
    if (sql.startsWith('SELECT id FROM pagos_informados WHERE pago_esperado_id')) {
      return state.pagos_informados.filter((x) => x.pago_esperado_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    if (sql.startsWith('SELECT id, version, hash_sha256, r2_key FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    if (sql.startsWith('SELECT * FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    if (sql.includes('FROM comprobantes c') && sql.includes('JOIN pagos_informados pi')) {
      return state.comprobantes.filter((c) => c.id === p[0] && c.tipo === 'pago' && state.pagos_informados.some((pi) => pi.id === c.referencia_id && pi.pago_esperado_id === p[1]) && c.venta_id === p[2]);
    }
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
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      state.eventos_historial.push({ id: p[0] });
    } else if (sql.startsWith("UPDATE pagos_esperados SET estado = 'pendiente'")) {
      const pago = state.pagos_esperados.find((x) => x.id === p[0]);
      if (pago) pago.estado = 'pendiente';
    } else if (sql.startsWith('UPDATE comprobantes SET rechazado_por')) {
      const c = state.comprobantes.find((x) => x.id === p[3]);
      if (c) { c.rechazado_por = p[0]; c.rechazado_en = p[1]; c.motivo_rechazo = p[2]; }
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

function fakeContext({ method = 'GET', roleIdentity: ri, db, bucket, params = { id: 'venta-1', pagoId: 'pago-x' }, formFile } = {}) {
  const init = { method };
  if (formFile) {
    const fd = new FormData();
    fd.append('archivo', formFile);
    init.body = fd;
  }
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas/venta-1/pagos/pago-x/comprobante', init),
    env: { DB: db, COMPROBANTES: bucket || fakeR2() },
    params,
    data: { requestId: 'req-comprobante-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

test('comprobante: el vendedor de la venta puede subir un comprobante de su propio pago ya informado', async () => {
  const db = fakeDbRuta();
  const bucket = fakeR2();
  const response = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, bucket, formFile: makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf') }));
  assert.equal(response.status, 201);
  assert.equal(db._state.comprobantes.length, 1);
  assert.equal(db._state.comprobantes[0].subido_por, VENDEDOR);
});

test('comprobante: subir antes de informar el pago se rechaza con un error de validación explícito', async () => {
  const db = fakeDbRuta({ pagoEstado: 'pendiente', conInformado: false });
  const response = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, formFile: makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf') }));
  assert.equal(response.status, 400);
});

test('comprobante: un ejecutivo ajeno a la venta recibe 404 (ni siquiera confirma que la venta existe)', async () => {
  const db = fakeDbRuta();
  const otro = roleIdentity({ email: 'ejecutivo.otro@example.com' });
  const response = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: otro, db }));
  assert.equal(response.status, 404);
});

test('comprobante: un supervisor del MISMO mercado ve que la venta existe en otras rutas, pero recibe 403 al pedir el comprobante — nunca el archivo bancario ajeno', async () => {
  const db = fakeDbRuta();
  const response = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: supervisorMismoMercado(), db }));
  assert.equal(response.status, 403);
});

test('comprobante: un supervisor tampoco puede SUBIR un comprobante ajeno', async () => {
  const db = fakeDbRuta();
  const response = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: supervisorMismoMercado(), db, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  assert.equal(response.status, 403);
});

test('comprobante: un supervisor de OTRO mercado recibe 404 (ni ve que la venta existe)', async () => {
  const db = fakeDbRuta();
  const otroMercado = supervisorMismoMercado({ allowedMarkets: ['AR'] });
  const response = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: otroMercado, db }));
  assert.equal(response.status, 404);
});

test('comprobante: administración SÍ puede consultar y subir el comprobante de una venta ajena de su mercado', async () => {
  const db = fakeDbRuta();
  const consulta = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: admin(), db }));
  assert.equal(consulta.status, 200);
  const subida = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: admin(), db, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  assert.equal(subida.status, 201);
});

test('comprobante: un asistente sin relación con la venta (ni vendedor ni admin) recibe 404, sin acceso a documentación financiera', async () => {
  const db = fakeDbRuta();
  const asistenteAjeno = roleIdentity({ email: 'practicante.ajeno@example.com', role: 'asistente', canSell: false, permissions: PERMISSIONS.asistente });
  const response = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: asistenteAjeno, db }));
  assert.equal(response.status, 404);
});

test('comprobante: GET sin ningún comprobante subido todavía devuelve comprobante:null, no un error', async () => {
  const db = fakeDbRuta();
  const response = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.comprobante, null);
});

test('comprobante: método no permitido (DELETE) — 405', async () => {
  const db = fakeDbRuta();
  const response = await comprobanteHandler(fakeContext({ method: 'DELETE', roleIdentity: roleIdentity(), db }));
  assert.equal(response.status, 405);
});

// --- Ruta de descarga del archivo real ---

test('archivo: el vendedor propio puede descargar el archivo real de su comprobante', async () => {
  const db = fakeDbRuta();
  const bucket = fakeR2();
  const subida = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, bucket, formFile: makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;

  const response = await archivoHandler(fakeContext({
    method: 'GET', roleIdentity: roleIdentity(), db, bucket,
    params: { id: 'venta-1', pagoId: 'pago-x', comprobanteId },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes], PDF_BYTES);
});

test('archivo: un supervisor del mismo mercado recibe 403 al intentar descargar el archivo, aunque conozca el id del comprobante', async () => {
  const db = fakeDbRuta();
  const bucket = fakeR2();
  const subida = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, bucket, formFile: makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;

  const response = await archivoHandler(fakeContext({
    method: 'GET', roleIdentity: supervisorMismoMercado(), db, bucket,
    params: { id: 'venta-1', pagoId: 'pago-x', comprobanteId },
  }));
  assert.equal(response.status, 403);
});

test('archivo: un comprobanteId inventado (o de otra venta) devuelve 404, nunca expone otro archivo', async () => {
  const db = fakeDbRuta();
  const response = await archivoHandler(fakeContext({
    method: 'GET', roleIdentity: roleIdentity(), db,
    params: { id: 'venta-1', pagoId: 'pago-x', comprobanteId: 'no-existe' },
  }));
  assert.equal(response.status, 404);
});

test('archivo: un objeto eliminado fuera de la aplicación (la fila sigue en D1, el objeto ya no está en R2) responde 500 genérico, sin filtrar la clave interna de R2', async () => {
  const db = fakeDbRuta();
  const bucketReal = fakeR2();
  const subida = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, bucket: bucketReal, formFile: makeFile(PDF_BYTES, 'x.pdf', 'application/pdf') }));
  const { id: comprobanteId } = (await subida.json()).data;

  const bucketVacio = { get: async () => null };
  const response = await archivoHandler(fakeContext({
    method: 'GET', roleIdentity: roleIdentity(), db, bucket: bucketVacio,
    params: { id: 'venta-1', pagoId: 'pago-x', comprobanteId },
  }));
  assert.equal(response.status, 500);
  const raw = JSON.stringify(await response.json());
  assert.doesNotMatch(raw, /r2_key|pago\/pi-/i, 'nunca expone la clave interna de R2 al cliente');
});

// --- Rechazar un pago informado (admin) ---

function fakeDbPagoRechazo() {
  const state = {
    ventas: [{ id: 'venta-1', vendedor_email: VENDEDOR, mercado: 'CL' }],
    proyectos: [{ id: 'proyecto-1', venta_id: 'venta-1' }],
    componentes: [],
    pagos_esperados: [{ id: 'pago-x', venta_id: 'venta-1', estado: 'informado' }],
    pagos_informados: [{ id: 'pi-1', pago_esperado_id: 'pago-x', created_at: '2026-08-31 00:00:00' }],
    comprobantes: [],
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
    if (sql.startsWith('SELECT id, vendedor_email, mercado FROM ventas')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT * FROM ventas WHERE id')) return state.ventas.filter((v) => v.id === p[0]);
    if (sql.startsWith('SELECT * FROM proyectos WHERE venta_id')) return state.proyectos.filter((pr) => pr.venta_id === p[0]);
    if (sql.startsWith('SELECT * FROM componentes WHERE proyecto_id')) return state.componentes.filter((c) => c.proyecto_id === p[0]);
    if (sql.startsWith('SELECT * FROM pagos_esperados WHERE venta_id')) return state.pagos_esperados.filter((x) => x.venta_id === p[0]);
    if (sql.startsWith('SELECT id, estado FROM pagos_esperados WHERE id = ? AND venta_id')) {
      return state.pagos_esperados.filter((x) => x.id === p[0] && x.venta_id === p[1]);
    }
    if (sql.startsWith('SELECT * FROM pagos_informados WHERE pago_esperado_id')) return state.pagos_informados.filter((x) => x.pago_esperado_id === p[0]);
    if (sql.startsWith('SELECT id FROM pagos_informados WHERE pago_esperado_id')) {
      return state.pagos_informados.filter((x) => x.pago_esperado_id === p[0]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    if (sql.startsWith('SELECT id, version, hash_sha256, r2_key FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    if (sql.startsWith('SELECT * FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1')) {
      return state.comprobantes.filter((c) => c.tipo === p[0] && c.referencia_id === p[1] && c.vigente === 1);
    }
    throw new Error('SELECT inesperado en test: ' + sql);
  }
  function runMutation(sql, p) {
    if (sql.startsWith("UPDATE pagos_esperados SET estado = 'pendiente'")) {
      const pago = state.pagos_esperados.find((x) => x.id === p[0]);
      if (pago) pago.estado = 'pendiente';
    } else if (sql.startsWith('UPDATE comprobantes SET vigente = 0')) {
      const c = state.comprobantes.find((x) => x.id === p[0]);
      if (c) c.vigente = 0;
    } else if (sql.startsWith('UPDATE comprobantes SET rechazado_por')) {
      const c = state.comprobantes.find((x) => x.id === p[3]);
      if (c) { c.rechazado_por = p[0]; c.rechazado_en = p[1]; c.motivo_rechazo = p[2]; }
    } else if (sql.startsWith('INSERT INTO comprobantes')) {
      state.comprobantes.push({
        id: p[0], tipo: p[1], referencia_id: p[2], venta_id: p[3], version: p[4], vigente: 1,
        r2_key: p[5], nombre_original: p[6], mime_type: p[7], tamano_bytes: p[8], hash_sha256: p[9], subido_por: p[10],
        rechazado_por: null, rechazado_en: null, motivo_rechazo: null,
      });
    } else if (sql.includes('INSERT INTO eventos_historial') && sql.includes("'comprobante'")) {
      // Insert embebido de guardarComprobante() — entidad va literal en el SQL, no bindeada.
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: 'comprobante', entidad_id: p[2], estado_anterior: p[3], estado_nuevo: p[4], usuario_email: p[5] });
    } else if (sql.startsWith('INSERT INTO eventos_historial')) {
      // Insert de 10 columnas de logEvento() (rechazarPago/rechazarComprobante).
      state.eventos_historial.push({ id: p[0], venta_id: p[1], entidad: p[2], entidad_id: p[3], estado_anterior: p[4], estado_nuevo: p[5], usuario_email: p[6], motivo_nota: p[7] });
    } else {
      throw new Error('mutación inesperada en test: ' + sql);
    }
  }
  return {
    _state: state,
    prepare: (sql) => makeStatement(sql),
    batch: async (statements) => {
      for (const stmt of statements) await stmt.run();
      return statements.map(() => ({ success: true }));
    },
  };
}

function fakeContextPago({ roleIdentity: ri, db, body }) {
  return {
    request: new Request('https://rioimpulsodigital.com/interno/api/ventas/venta-1/pagos/pago-x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env: { DB: db },
    params: { id: 'venta-1', pagoId: 'pago-x' },
    data: { requestId: 'req-rechazo-test', identity: { email: ri?.email }, roleIdentity: ri },
  };
}

test('rechazar: admin puede rechazar un pago informado, vuelve a pendiente para una corrección', async () => {
  const db = fakeDbPagoRechazo();
  const response = await pagoHandler(fakeContextPago({ roleIdentity: admin(), db, body: { action: 'rechazar', motivo: 'El comprobante no corresponde al monto informado.' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.pagos_esperados.find((p) => p.id === 'pago-x').estado, 'pendiente');
  assert.ok(db._state.eventos_historial.some((e) => e.estado_nuevo === 'pendiente' && e.motivo_nota));
});

test('rechazar: el vendedor NO puede rechazar su propio pago (exclusivo de admin)', async () => {
  const db = fakeDbPagoRechazo();
  const response = await pagoHandler(fakeContextPago({ roleIdentity: roleIdentity(), db, body: { action: 'rechazar', motivo: 'x' } }));
  assert.equal(response.status, 403);
});

test('rechazar: sin motivo se rechaza con un error de validación', async () => {
  const db = fakeDbPagoRechazo();
  const response = await pagoHandler(fakeContextPago({ roleIdentity: admin(), db, body: { action: 'rechazar' } }));
  assert.equal(response.status, 400);
});

test('rechazar: no se puede rechazar un pago ya acreditado', async () => {
  const db = fakeDbPagoRechazo();
  db._state.pagos_esperados[0].estado = 'acreditado';
  const response = await pagoHandler(fakeContextPago({ roleIdentity: admin(), db, body: { action: 'rechazar', motivo: 'x' } }));
  assert.equal(response.status, 409);
});

// --- Rechazo visible para el vendedor (RIO-116, verificación final,
// Brenda 31/08/2026 sección 2) — cuando administración rechaza un
// comprobante ya subido, el vendedor debe poder ver el estado rechazado
// y el motivo, saber que debe subir una versión nueva, y nunca poder
// modificar/borrar la anterior; el supervisor sigue sin acceso al
// archivo, aunque el estado haya cambiado. ---

test('rechazo visible: el vendedor ve el comprobante marcado como rechazado, con el motivo, después de que admin lo rechace', async () => {
  const db = fakeDbPagoRechazo();
  const bucket = fakeR2();

  // El vendedor ya había subido un comprobante para el pago informado.
  const subida = await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, bucket, formFile: makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf') }));
  assert.equal(subida.status, 201);

  // Admin rechaza el pago con un motivo — esto también debe marcar el
  // comprobante subyacente como rechazado (no solo revertir el pago).
  const rechazo = await pagoHandler(fakeContextPago({ roleIdentity: admin(), db, body: { action: 'rechazar', motivo: 'El monto del comprobante no coincide con lo informado.' } }));
  assert.equal(rechazo.status, 200);

  // El vendedor consulta y ve el estado rechazado con el motivo — sabe
  // que tiene que subir una versión nueva.
  const consulta = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  assert.equal(consulta.status, 200);
  const { comprobante } = (await consulta.json()).data;
  assert.ok(comprobante, 'el vendedor sigue viendo el comprobante (rechazado), no un "no existe"');
  assert.equal(comprobante.rechazadoPor, 'admin@example.com');
  assert.ok(comprobante.rechazadoEn);
  assert.equal(comprobante.motivoRechazo, 'El monto del comprobante no coincide con lo informado.');

  // Nunca puede modificar ni borrar la versión anterior — no existe
  // ninguna ruta de edición/borrado; la única forma de avanzar es subir
  // una nueva versión (ya probado en el bloque de versionado).
  assert.equal(db._state.comprobantes.length, 1, 'la versión rechazada sigue siendo la única fila — nadie la borró');

  // El supervisor SIGUE sin acceso al archivo, con o sin rechazo.
  const supervisorRespuesta = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: supervisorMismoMercado(), db }));
  assert.equal(supervisorRespuesta.status, 403);
});

test('rechazo visible: el motivo se devuelve tal cual lo escribió admin — texto libre, sin agregar detalle administrativo interno', async () => {
  const db = fakeDbPagoRechazo();
  const bucket = fakeR2();
  await comprobanteHandler(fakeContext({ method: 'POST', roleIdentity: roleIdentity(), db, bucket, formFile: makeFile(PDF_BYTES, 'comprobante.pdf', 'application/pdf') }));
  await pagoHandler(fakeContextPago({ roleIdentity: admin(), db, body: { action: 'rechazar', motivo: 'Falta la fecha de la transferencia.' } }));

  const consulta = await comprobanteHandler(fakeContext({ method: 'GET', roleIdentity: roleIdentity(), db }));
  const { comprobante } = (await consulta.json()).data;
  assert.equal(comprobante.motivoRechazo, 'Falta la fecha de la transferencia.');
  const raw = JSON.stringify(comprobante);
  assert.doesNotMatch(raw, /r2_key|hash_sha256/i, 'la respuesta al vendedor nunca expone claves internas, aunque el comprobante esté rechazado');
});

test('rechazo visible: rechazar un pago sin ningún comprobante subido todavía es válido (no hay archivo que marcar, no es un error)', async () => {
  const db = fakeDbPagoRechazo();
  const response = await pagoHandler(fakeContextPago({ roleIdentity: admin(), db, body: { action: 'rechazar', motivo: 'Monto informado incorrecto, sin comprobante adjunto.' } }));
  assert.equal(response.status, 200);
  assert.equal(db._state.comprobantes.length, 0);
});
