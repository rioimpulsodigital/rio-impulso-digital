// Pruebas de functions/_shared/crypto.js — RIO-119 (tercer bloque, datos
// sensibles cifrados, 02/09/2026). Cubre directamente los obligatorios de
// Brenda: dos cifrados del mismo valor nunca son iguales (IV aleatorio),
// una clave o versión incorrecta falla de forma controlada, el valor
// guardado nunca contiene el texto original, y null/'' nunca se cifra.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, decryptField, CryptoConfigError } from '../functions/_shared/crypto.js';

function fakeEnv(overrides = {}) {
  // Clave de prueba fija — NUNCA la real de Preview/Producción, generada
  // solo para que estas pruebas sean deterministas y no dependan de ningún
  // secreto real.
  return { DATOS_SENSIBLES_KEY_V1: 'ooairIYpX84V8LsrlfjzFZmTUxS3AbLdo9A+YIEqdAM=', ...overrides };
}

test('encryptField/decryptField — cifra y descifra el mismo valor exacto', async () => {
  const env = fakeEnv();
  const stored = await encryptField(env, '12.345.678-9');
  const recovered = await decryptField(env, stored);
  assert.equal(recovered, '12.345.678-9');
});

test('encryptField — dos cifrados del mismo valor NUNCA producen el mismo resultado (IV aleatorio)', async () => {
  const env = fakeEnv();
  const a = await encryptField(env, 'mismo-valor');
  const b = await encryptField(env, 'mismo-valor');
  assert.notEqual(a, b);
  // Pero ambos descifran al mismo texto plano.
  assert.equal(await decryptField(env, a), 'mismo-valor');
  assert.equal(await decryptField(env, b), 'mismo-valor');
});

test('encryptField — el valor guardado nunca contiene el texto original', async () => {
  const env = fakeEnv();
  const secreto = 'CBU-0000003100099887766555';
  const stored = await encryptField(env, secreto);
  assert.equal(stored.includes(secreto), false);
});

test('encryptField — null, undefined y string vacío nunca se cifran (se guardan como null)', async () => {
  const env = fakeEnv();
  assert.equal(await encryptField(env, null), null);
  assert.equal(await encryptField(env, undefined), null);
  assert.equal(await encryptField(env, ''), null);
});

test('decryptField — null/undefined devuelve null sin intentar desencriptar', async () => {
  const env = fakeEnv();
  assert.equal(await decryptField(env, null), null);
  assert.equal(await decryptField(env, undefined), null);
});

test('decryptField — falta la clave de la versión: falla controlado (CryptoConfigError), nunca datos basura', async () => {
  const env = fakeEnv();
  const stored = await encryptField(env, 'valor');
  await assert.rejects(
    () => decryptField({}, stored), // sin DATOS_SENSIBLES_KEY_V1 configurada.
    (e) => e instanceof CryptoConfigError && e.reason === 'missing_key_version_1'
  );
});

test('decryptField — clave incorrecta (versión distinta con otro valor): falla controlado, AES-GCM detecta la manipulación', async () => {
  const env = fakeEnv();
  const stored = await encryptField(env, 'valor');
  const envConClaveEquivocada = fakeEnv({ DATOS_SENSIBLES_KEY_V1: 'sIPKei3YPMn7RFvocugj23l+l+PqIjN3WR5noBjblqM=' });
  await assert.rejects(
    () => decryptField(envConClaveEquivocada, stored),
    (e) => e instanceof CryptoConfigError && e.reason === 'decrypt_failed'
  );
});

test('decryptField — un valor corrupto/manipulado falla controlado, nunca descifra a datos inventados', async () => {
  const env = fakeEnv();
  const stored = await encryptField(env, 'valor original');
  // Corrompe el ciphertext (última porción, tras el segundo ":").
  const partes = stored.split(':');
  const corrupto = partes[0] + ':' + partes[1] + ':' + partes[2].slice(0, -4) + 'AAAA';
  await assert.rejects(() => decryptField(env, corrupto), (e) => e instanceof CryptoConfigError);
});

test('rotación de clave: un valor cifrado con la versión anterior sigue descifrando si esa versión sigue configurada', async () => {
  // Simula una rotación: DATOS_SENSIBLES_KEY_V1 sigue disponible aunque ya
  // no sea la versión "actual" para cifrar — CURRENT_KEY_VERSION es interno
  // al módulo, pero el formato guardado ('v1:...') sigue siendo válido
  // mientras exista la variable de entorno correspondiente.
  const env = fakeEnv();
  const stored = await encryptField(env, 'dato-antes-de-rotar');
  assert.ok(stored.startsWith('v1:'));
  const recovered = await decryptField(env, stored);
  assert.equal(recovered, 'dato-antes-de-rotar');
});
