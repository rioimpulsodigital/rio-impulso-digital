// Notificaciones internas — RIO-116, segundo bloque (Brenda: "crear una
// notificación interna para Administración" al informar un pago o subir
// una nueva versión de un comprobante). Nunca un email ni una URL
// pública — un registro en D1 con una ruta relativa al portal, protegida
// por Cloudflare Access como cualquier otra ruta de `/interno/*`. El
// procedimiento temporal por correo (RIO-113/RIO-116, decisiones del
// 28/08/2026) sigue vigente hasta que exista una interfaz real que
// consuma esto — hoy es API-only, sin panel (RIO-119).
//
// `rutaPortal` es deliberadamente provisional: apunta a
// `/interno/index.html?venta=...&pago=...` porque no existe todavía
// ningún enrutamiento real dentro del Portal para estos casos — cuando
// se construya el panel administrativo, esa ruta cambia, no el modelo de
// datos.

import { execute, query } from './db.js';

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Idempotente por diseño: `claveIdempotencia` se deriva del evento real
// que origina la notificación (nunca de un id de solicitud HTTP, que
// esta capa no ve) — un segundo intento de notificar el MISMO evento
// (ej. un reintento de red que vuelve a ejecutar este mismo código) nunca
// crea una fila adicional, devuelve la ya existente.
export async function crearNotificacionSiCorresponde(db, requestId, {
  tipo, claveIdempotencia, ventaId, pagoId, mercado, clienteNegocio, vendedorEmail, rutaPortal,
}) {
  // RIO-119 (tercer bloque, item 5, 03/09/2026): un proyecto marcado como
  // importación histórica nunca genera notificaciones operativas — puerta
  // única acá para cubrir los tres puntos que hoy disparan notificaciones
  // desde /ventas/:id/* sin que cada uno tenga que recordar filtrarlo.
  if (ventaId) {
    const ventaRows = await query(db, requestId, 'SELECT modo_historico FROM ventas WHERE id = ?', [ventaId]);
    if (ventaRows[0]?.modo_historico) return null;
  }

  const existentes = await query(db, requestId, 'SELECT id FROM notificaciones WHERE clave_idempotencia = ?', [claveIdempotencia]);
  if (existentes[0]) return existentes[0].id;

  const id = crypto.randomUUID();
  await execute(
    db, requestId,
    `INSERT INTO notificaciones (id, tipo, clave_idempotencia, venta_id, pago_id, mercado, cliente_negocio, vendedor_email, ruta_portal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tipo, claveIdempotencia, ventaId || null, pagoId || null, mercado || null, clienteNegocio || null, vendedorEmail || null, rutaPortal]
  );
  return id;
}

export async function listarNotificaciones(db, requestId, { soloPendientes = false } = {}) {
  const sql = soloPendientes
    ? "SELECT * FROM notificaciones WHERE destinatario_rol = 'admin' AND atendida_en IS NULL ORDER BY created_at DESC"
    : "SELECT * FROM notificaciones WHERE destinatario_rol = 'admin' ORDER BY created_at DESC";
  return query(db, requestId, sql, []);
}

export async function marcarNotificacionLeida(db, requestId, { notificacionId, actorEmail }) {
  await execute(
    db, requestId,
    'UPDATE notificaciones SET leida_en = ?, leida_por = ? WHERE id = ? AND leida_en IS NULL',
    [nowSql(), actorEmail, notificacionId]
  );
}

export async function marcarNotificacionAtendida(db, requestId, { notificacionId, actorEmail }) {
  await execute(
    db, requestId,
    'UPDATE notificaciones SET atendida_en = ?, atendida_por = ? WHERE id = ? AND atendida_en IS NULL',
    [nowSql(), actorEmail, notificacionId]
  );
}
