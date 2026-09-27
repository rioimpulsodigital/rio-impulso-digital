// Capa de acceso a D1 — RIO-110 sección 7.
//
// Principio: el frontend nunca ve SQL. Todo lo que toca la base pasa por acá,
// con consultas parametrizadas (`bind()`), nunca concatenación de strings.
// En RIO-110 solo existe la tabla técnica `_system_health` (sección 6/9) —
// el modelo de negocio (usuarios, ventas, comisiones) es RIO-111 en adelante.

export class DbError extends Error {
  constructor(reason, cause) {
    super(reason);
    this.name = 'DbError';
    this.reason = reason;
    this.cause = cause || null;
  }
}

// Log técnico mínimo: request id + tipo de error, nunca la consulta, los
// parámetros ni el mensaje crudo del driver (podría incluir fragmentos de SQL
// o de datos). Suficiente para correlacionar un incidente sin filtrar nada.
function logDbError(requestId, reason) {
  console.error(JSON.stringify({ requestId, scope: 'db', reason }));
}

// Ejecuta una consulta que devuelve filas (SELECT). `sql` debe usar `?`
// como placeholder; `params` es un array posicional — nunca interpolar
// valores directamente en `sql`.
export async function query(db, requestId, sql, params = []) {
  try {
    const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
    const result = await stmt.all();
    return result.results ?? [];
  } catch (e) {
    logDbError(requestId, 'query_failed');
    throw new DbError('query_failed', e);
  }
}

// Ejecuta una consulta que no devuelve filas (INSERT/UPDATE/DELETE de una
// sola sentencia). Para varias sentencias que deben aplicarse todas o
// ninguna, usar `transaction()`.
export async function execute(db, requestId, sql, params = []) {
  try {
    const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
    return await stmt.run();
  } catch (e) {
    logDbError(requestId, 'execute_failed');
    throw new DbError('execute_failed', e);
  }
}

// Agrupa varias sentencias preparadas en un solo `batch()` — D1 las ejecuta
// de forma secuencial y no concurrente, revirtiendo toda la secuencia si una
// falla (confirmado en la auditoría RIO-108, sección 5). Esto es lo que
// tareas futuras (RIO-113/114) van a usar para las condiciones "las tres a la
// vez" de RIO-97 (ej. habilitar Landing en un pack). En RIO-110 no hay
// todavía ninguna transacción de negocio — esta función solo deja lista la
// capa para que RIO-111+ no tenga que reinventarla.
export async function transaction(db, requestId, statements) {
  try {
    return await db.batch(statements);
  } catch (e) {
    logDbError(requestId, 'transaction_failed');
    throw new DbError('transaction_failed', e);
  }
}

// Comprobación técnica mínima de conectividad — usada por /interno/api/health
// (sección 9). No consulta ninguna tabla de negocio: solo confirma que el
// binding existe y que D1 responde a una consulta trivial.
export async function checkConnectivity(db, requestId) {
  try {
    const result = await db.prepare('SELECT 1 AS ok').first();
    return result && result.ok === 1;
  } catch (e) {
    logDbError(requestId, 'connectivity_check_failed');
    return false;
  }
}
