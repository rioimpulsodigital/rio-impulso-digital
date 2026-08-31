// Validación y almacenamiento de comprobantes — RIO-116 (Brenda,
// decisiones confirmadas 28/08 y consolidadas 31/08/2026).
//
// Principio de validación: allowlist estricta, nunca una blocklist. Solo
// se reconocen 3 firmas reales de archivo (PDF/JPG/PNG) — cualquier otra
// cosa (SVG, HTML, un ejecutable, un archivo corrupto) simplemente no
// coincide con ninguna firma conocida y se rechaza, sin necesidad de
// enumerar qué se prohíbe. La extensión declarada y el Content-Type que
// mandó el navegador son señales adicionales que deben COINCIDIR con la
// firma real — nunca se confía en ellas solas (un .pdf con contenido
// ejecutable no pasa, aunque el navegador diga application/pdf).

import { logEvento } from './historial.js';
import { execute, query } from './db.js';

export class ArchivoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchivoError';
    this.code = code;
  }
}

// Límite inicial confirmado por Brenda — "máximo inicial de 10 MB".
export const MAX_COMPROBANTE_BYTES = 10 * 1024 * 1024;

const EXTENSION_MIME = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
});

// Saneamiento del nombre VISIBLE (RIO-116, segundo bloque) — nunca se usa
// para construir la ruta física en R2 (esa siempre es una clave interna
// no predecible, ver `nuevaClaveR2` abajo), pero sí se muestra en
// `Content-Disposition` al descargar — hay que evitar inyección de
// cabecera (saltos de línea, comillas) y rutas escondidas (../, /).
function sanearNombreVisible(nombre) {
  const limpio = (nombre || 'comprobante')
    .replace(/[\r\n]/g, ' ')
    .replace(/["\\]/g, '')
    .replace(/[/\\]/g, '_')
    .trim();
  return limpio.slice(0, 150) || 'comprobante';
}

function detectarFirmaReal(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf'; // %PDF
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Valida un `File` (de FormData) y devuelve los metadatos verificados —
// nunca los datos que declaró el cliente sin cruzarlos contra el
// contenido real. Lanza ArchivoError con un código específico ante
// cualquier discrepancia.
export async function validarComprobante(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new ArchivoError('archivo_faltante', 'Falta el archivo.');
  }
  if (typeof file.size === 'number' && file.size > MAX_COMPROBANTE_BYTES) {
    throw new ArchivoError('archivo_demasiado_grande', `El archivo supera el límite de ${MAX_COMPROBANTE_BYTES / (1024 * 1024)} MB.`);
  }

  const nombreOriginal = file.name || 'comprobante';
  const extension = nombreOriginal.includes('.') ? nombreOriginal.toLowerCase().split('.').pop() : '';
  const mimeEsperadoPorExtension = EXTENSION_MIME[extension];
  if (!mimeEsperadoPorExtension) {
    throw new ArchivoError('extension_no_permitida', 'Extensión no permitida. Solo se aceptan PDF, JPG o PNG.');
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_COMPROBANTE_BYTES) {
    throw new ArchivoError('archivo_demasiado_grande', `El archivo supera el límite de ${MAX_COMPROBANTE_BYTES / (1024 * 1024)} MB.`);
  }
  if (buffer.byteLength === 0) {
    throw new ArchivoError('archivo_vacio', 'El archivo está vacío.');
  }

  const bytes = new Uint8Array(buffer);
  const firmaReal = detectarFirmaReal(bytes);
  if (!firmaReal) {
    throw new ArchivoError('firma_no_reconocida', 'El contenido del archivo no corresponde a un PDF, JPG o PNG válido.');
  }
  if (firmaReal !== mimeEsperadoPorExtension) {
    throw new ArchivoError('extension_no_coincide', 'La extensión del archivo no coincide con su contenido real.');
  }
  const mimeDeclarado = file.type;
  if (mimeDeclarado && mimeDeclarado !== firmaReal) {
    throw new ArchivoError('mime_no_coincide', 'El tipo de archivo declarado no coincide con su contenido real.');
  }

  const hashSha256 = await sha256Hex(buffer);
  return { buffer, mimeType: firmaReal, tamanoBytes: buffer.byteLength, hashSha256, nombreOriginal: sanearNombreVisible(nombreOriginal), extension };
}

// Clave interna de R2 — deliberadamente NO PREDECIBLE (Brenda, segundo
// bloque: "usar claves internas no predecibles en R2... no utilizar el
// nombre aportado por el usuario como ruta física"). El prefijo
// `tipo/referenciaId/vN` es solo para que un humano pueda orientarse
// mirando el bucket — la parte que realmente evita que alguien adivine
// la clave de otro archivo es el UUID aleatorio al final, nunca derivado
// del contenido ni del nombre del archivo.
function nuevaClaveR2({ tipo, referenciaId, version }) {
  return `${tipo}/${referenciaId}/v${version}-${crypto.randomUUID()}`;
}

// Sube un comprobante ya validado a R2 y registra su versión en D1 —
// nunca sobrescribe: si ya existía una versión vigente para el mismo
// (tipo, referenciaId), esa fila pasa a vigente=0 (su objeto en R2 queda
// intacto, solo deja de ser "el actual", incluidos sus campos de rechazo
// si los tenía — quedan como historial) y se inserta una fila nueva,
// limpia, con version+1.
//
// Idempotencia ante reintentos (Brenda, segundo bloque: "reintento sin
// duplicar archivos"): si el archivo recién validado tiene EXACTAMENTE el
// mismo hash que la versión vigente, no se sube un objeto nuevo a R2 ni
// se inserta una fila nueva — se asume que es el mismo intento repetido
// (ej. un reintento de red), y se devuelve la versión ya existente tal
// cual. Un archivo con contenido distinto (aunque sea una corrección
// mínima) sí genera una versión nueva, como corresponde.
export async function guardarComprobante(db, bucket, requestId, { tipo, referenciaId, ventaId, archivo, subidoPor }) {
  const anteriores = await query(
    db, requestId,
    'SELECT id, version, hash_sha256, r2_key FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1',
    [tipo, referenciaId]
  );
  const anterior = anteriores[0];
  if (anterior && anterior.hash_sha256 === archivo.hashSha256) {
    return { id: anterior.id, version: anterior.version, r2Key: anterior.r2_key };
  }
  const version = anterior ? anterior.version + 1 : 1;

  const r2Key = nuevaClaveR2({ tipo, referenciaId, version });
  await bucket.put(r2Key, archivo.buffer, {
    httpMetadata: { contentType: archivo.mimeType },
  });

  if (anterior) {
    await execute(db, requestId, 'UPDATE comprobantes SET vigente = 0 WHERE id = ?', [anterior.id]);
  }

  const id = crypto.randomUUID();
  await execute(
    db, requestId,
    `INSERT INTO comprobantes (id, tipo, referencia_id, venta_id, version, vigente, r2_key, nombre_original, mime_type, tamano_bytes, hash_sha256, subido_por)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [id, tipo, referenciaId, ventaId || null, version, r2Key, archivo.nombreOriginal, archivo.mimeType, archivo.tamanoBytes, archivo.hashSha256, subidoPor]
  );
  await logEvento(db, requestId, {
    ventaId: ventaId || null, entidad: 'comprobante', entidadId: id,
    estadoAnterior: anterior ? `version_${anterior.version}` : null, estadoNuevo: `version_${version}`, usuarioEmail: subidoPor,
  });

  return { id, version, r2Key };
}

// Devuelve la fila vigente (metadatos, nunca el archivo) de un
// comprobante, o null si nunca se subió ninguno para esa referencia.
export async function obtenerComprobanteVigente(db, requestId, { tipo, referenciaId }) {
  const rows = await query(
    db, requestId,
    'SELECT * FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1',
    [tipo, referenciaId]
  );
  return rows[0] || null;
}

// Respuesta HTTP para servir el archivo real — RIO-116 segundo bloque,
// controles de seguridad reforzados: SIEMPRE como adjunto (nunca inline,
// nunca se renderiza dentro del portal — validar la firma real no
// equivale a un análisis antimalware, ver nota de riesgo residual en
// RIO-116), `X-Content-Type-Options: nosniff` para que el navegador no
// intente adivinar otro tipo, y sin caché (documento financiero — nunca
// debe quedar en el historial del navegador ni en un proxy intermedio).
// Nunca un link permanente: esta respuesta se genera de nuevo, con
// autorización revalidada, en cada solicitud.
export function respuestaArchivoSeguro(object, comprobante) {
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': comprobante.mime_type,
      'Content-Disposition': `attachment; filename="${comprobante.nombre_original}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store, no-cache, must-revalidate',
    },
  });
}

export class ComprobanteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComprobanteError';
    this.code = code;
  }
}

// Rechaza el comprobante VIGENTE de una referencia (RIO-116, segundo
// bloque) — usado para conversión y transferencia (el comprobante de pago
// tiene su propio flujo de rechazo a nivel del PAGO, ver
// `rechazarPago()` en proyectos.js, ya construido en el primer bloque).
// Nunca borra ni reemplaza el archivo — solo dejar constancia de que
// administración lo rechazó, quién y por qué, hasta que se suba una
// versión nueva (que empieza "limpia", sin estos campos).
// `comprobanteIdEsperado` es una defensa contra manipulación de ID: si el
// cliente referenció un comprobante que YA NO es el vigente (una versión
// vieja, o un id de otra referencia), se rechaza explícitamente en vez de
// rechazar en silencio "lo que sea que esté vigente ahora" — evita
// sorprender a un admin que cree estar rechazando la versión 1 cuando en
// realidad ya existe una versión 2 más reciente.
export async function rechazarComprobante(db, requestId, { tipo, referenciaId, comprobanteIdEsperado, motivo, actorEmail }) {
  const vigente = await obtenerComprobanteVigente(db, requestId, { tipo, referenciaId });
  if (!vigente) {
    throw new ComprobanteError('comprobante_no_encontrado', 'No hay ningún comprobante vigente para rechazar.');
  }
  if (comprobanteIdEsperado && vigente.id !== comprobanteIdEsperado) {
    throw new ComprobanteError('version_no_vigente', 'El comprobante indicado ya no es la versión vigente — no se puede rechazar una versión reemplazada.');
  }
  const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await execute(
    db, requestId,
    'UPDATE comprobantes SET rechazado_por = ?, rechazado_en = ?, motivo_rechazo = ? WHERE id = ?',
    [actorEmail, ahora, motivo, vigente.id]
  );
  await logEvento(db, requestId, {
    ventaId: vigente.venta_id || null, entidad: 'comprobante', entidadId: vigente.id,
    estadoAnterior: `version_${vigente.version}`, estadoNuevo: 'rechazado', usuarioEmail: actorEmail, motivoNota: motivo,
  });
  return vigente.id;
}

// Estado documental de una liquidación (RIO-116, segundo bloque, sección
// 3) — 5 valores posibles, nunca inferidos del estado de pago de las
// comisiones (son hechos relacionados, pero distintos):
//   - sin_comprobantes: ni conversión (si hacía falta) ni transferencia.
//   - conversion_documentada: todas las conversiones que hacían falta
//     están documentadas, pero falta el comprobante de transferencia.
//   - transferencia_documentada: el comprobante de transferencia está,
//     pero todavía falta alguna conversión necesaria.
//   - documentacion_completa: las dos cosas, cuando ambas aplican (si la
//     liquidación no necesitaba ninguna conversión — todo en la misma
//     moneda —, alcanza con la transferencia).
//   - rechazado_pendiente_reemplazo: cualquiera de los documentos
//     vigentes relevantes fue rechazado por administración y todavía no
//     se subió su reemplazo — tiene prioridad sobre los otros estados.
export async function calcularEstadoDocumentalLiquidacion(db, requestId, liquidacionId) {
  const conversionesNecesarias = await query(
    db, requestId,
    'SELECT DISTINCT conversion_id FROM transferencia_detalle WHERE transferencia_id = ? AND conversion_id IS NOT NULL',
    [liquidacionId]
  );
  const comprobanteTransferencia = await obtenerComprobanteVigente(db, requestId, { tipo: 'transferencia', referenciaId: liquidacionId });

  let algunoRechazado = !!(comprobanteTransferencia && comprobanteTransferencia.rechazado_en);
  let conversionesFaltantes = 0;
  for (const fila of conversionesNecesarias) {
    const comprobante = await obtenerComprobanteVigente(db, requestId, { tipo: 'conversion', referenciaId: fila.conversion_id });
    if (!comprobante) conversionesFaltantes += 1;
    else if (comprobante.rechazado_en) algunoRechazado = true;
  }

  if (algunoRechazado) return 'rechazado_pendiente_reemplazo';

  const conversionCompleta = conversionesFaltantes === 0;
  const transferenciaCompleta = !!comprobanteTransferencia;

  if (conversionCompleta && transferenciaCompleta) return 'documentacion_completa';
  if (conversionesNecesarias.length > 0 && conversionCompleta && !transferenciaCompleta) return 'conversion_documentada';
  if (transferenciaCompleta && !conversionCompleta) return 'transferencia_documentada';
  return 'sin_comprobantes';
}
