// Historial append-only compartido — extraído de proyectos.js (RIO-113) al
// agregar RIO-114 (comisiones.js), que también necesita registrar eventos
// sin crear una dependencia circular entre ambos módulos de negocio.
//
// Nunca se hace UPDATE ni DELETE sobre eventos_historial en ningún otro
// lugar del código — esta es la única función que escribe en esa tabla.

import { execute } from './db.js';

export async function logEvento(db, requestId, {
  ventaId, entidad, entidadId, estadoAnterior, estadoNuevo, usuarioEmail,
  motivoNota, proximaAccion, responsableProximaAccion,
}) {
  await execute(
    db, requestId,
    `INSERT INTO eventos_historial
       (id, venta_id, entidad, entidad_id, estado_anterior, estado_nuevo, usuario_email, motivo_nota, proxima_accion, responsable_proxima_accion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), ventaId, entidad, entidadId, estadoAnterior || null, estadoNuevo, usuarioEmail, motivoNota || null, proximaAccion || null, responsableProximaAccion || null]
  );
}
