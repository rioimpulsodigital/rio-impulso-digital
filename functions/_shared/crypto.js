// Cifrado de datos sensibles — RIO-119 (tercer bloque, 02/09/2026).
//
// AES-GCM (autenticado) vía Web Crypto — la clave vive EXCLUSIVAMENTE como
// secreto del entorno de Cloudflare (`DATOS_SENSIBLES_KEY_V<n>`, distinta en
// Preview y Producción, nunca en D1/código/logs/Notion — ver
// .dev.vars.example). El valor guardado incluye la versión de clave usada
// (`v<n>:<iv>:<ciphertext>`) para poder rotar la clave más adelante sin
// perder los datos ya cifrados con una versión anterior — con solo agregar
// `DATOS_SENSIBLES_KEY_V2` y subir CURRENT_KEY_VERSION, lo viejo se sigue
// desencriptando con su propia clave.
//
// IV/nonce aleatorio y ÚNICO en cada llamada a encryptField() — nunca
// reutilizado — es lo que garantiza que dos cifrados del mismo valor
// nunca produzcan el mismo resultado, aunque la clave sea la misma.
//
// Nunca loggear el valor plano ni el cifrado completo — ver logCryptoError.

export class CryptoConfigError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CryptoConfigError';
    this.reason = reason;
  }
}

const CURRENT_KEY_VERSION = 1;

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(env, version) {
  const raw = env['DATOS_SENSIBLES_KEY_V' + version];
  if (!raw) {
    // Nunca se cae a una clave por defecto ni se guarda sin cifrar —
    // sin el secreto configurado, la operación falla de forma controlada.
    throw new CryptoConfigError('missing_key_version_' + version);
  }
  let keyBytes;
  try {
    keyBytes = base64ToBytes(raw);
  } catch (e) {
    throw new CryptoConfigError('malformed_key_version_' + version);
  }
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// null/undefined/'' se guardan como null — nunca se cifra un valor vacío
// (evita filtrar por longitud de ciphertext que un campo está "vacío vs.
// lleno" de forma distinta a como ya lo revela una columna NULL).
export async function encryptField(env, plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = await importKey(env, CURRENT_KEY_VERSION);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96 bits, el tamaño recomendado para AES-GCM.
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plaintext)));
  return `v${CURRENT_KEY_VERSION}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
}

export async function decryptField(env, stored) {
  if (!stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 3 || !parts[0].startsWith('v')) {
    throw new CryptoConfigError('malformed_stored_value');
  }
  const version = parseInt(parts[0].slice(1), 10);
  const key = await importKey(env, version);
  const iv = base64ToBytes(parts[1]);
  const cipherBytes = base64ToBytes(parts[2]);
  try {
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
    return new TextDecoder().decode(plainBuffer);
  } catch (e) {
    // AES-GCM es autenticado — una clave equivocada o un valor corrupto
    // fallan acá de forma controlada, nunca devuelven basura silenciosa.
    throw new CryptoConfigError('decrypt_failed');
  }
}

// Enmascarado GENÉRICO (nunca derivado del valor real, ni siquiera un
// "últimos 4 dígitos") — el valor completo solo se conoce llamando a
// decryptField() desde una acción explícita de revelar, nunca por defecto.
export const MASKED_PLACEHOLDER = '••••••••';

// Log técnico seguro: nunca el valor plano, nunca el cifrado completo —
// mismo criterio que logDbError (functions/_shared/db.js).
export function logCryptoError(requestId, scope, reason) {
  console.error(JSON.stringify({ requestId, scope, reason }));
}
