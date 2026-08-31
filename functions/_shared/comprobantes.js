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
  return { buffer, mimeType: firmaReal, tamanoBytes: buffer.byteLength, hashSha256, nombreOriginal, extension };
}

// Sube un comprobante ya validado a R2 y registra su versión en D1 —
// nunca sobrescribe: si ya existía una versión vigente para el mismo
// (tipo, referenciaId), esa fila pasa a vigente=0 (su objeto en R2 queda
// intacto, solo deja de ser "el actual") y se inserta una fila nueva con
// version+1. La clave de R2 incluye el hash — dos subidas nunca chocan de
// clave, aunque sean el mismo archivo re-subido dos veces.
export async function guardarComprobante(db, bucket, requestId, { tipo, referenciaId, ventaId, archivo, subidoPor }) {
  const anteriores = await query(
    db, requestId,
    'SELECT id, version FROM comprobantes WHERE tipo = ? AND referencia_id = ? AND vigente = 1',
    [tipo, referenciaId]
  );
  const anterior = anteriores[0];
  const version = anterior ? anterior.version + 1 : 1;

  const r2Key = `${tipo}/${referenciaId}/v${version}-${archivo.hashSha256.slice(0, 16)}`;
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
