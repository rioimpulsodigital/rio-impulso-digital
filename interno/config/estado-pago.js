/*
 * Estado visible del pago — RIO-122 (13/09/2026, segunda corrección de UAT).
 *
 * Única fuente de la etiqueta/badge que traducen `estadoOperativo` +
 * `estadoPagoResumen` (ambos ya calculados por el servidor, ver
 * functions/interno/api/ventas/index.js y [id].js) a lo que ve el
 * usuario en la columna "Estado" de cualquier tabla de ventas —
 * panel-vendedor.js, panel-supervisor.js, panel-administrativo.js.
 *
 * Antes existían 3 copias independientes de esta misma lógica (una por
 * panel, agregadas en la primera corrección de RIO-122) — funcionalmente
 * correctas, pero exactamente el riesgo que esta segunda vuelta de UAT
 * expuso: divergencia entre implementaciones y, sobre todo, el "?v=" de
 * cada panel-*.js no se actualizó al tocarlos, así que Cloudflare siguió
 * sirviendo el JS viejo — la tabla seguía mostrando "En espera de pago"
 * aunque el detalle (que sí se recarga siempre) ya mostraba "Informado".
 * Un archivo nuevo, con su propio "?v=" de estreno, es imposible que
 * arrastre caché de una versión anterior.
 *
 * `estadoOperativo` interno sigue siendo 'en_espera_pago' hasta la
 * validación administrativa (RIO-117) — esta regla de negocio no cambia.
 * Este archivo solo resuelve qué texto/color mostrar dentro de ese único
 * estado operativo, a partir de `estadoPagoResumen`
 * (pendiente | informado | rechazado | acreditado — RIO-122).
 *
 * Cargar este script ANTES del panel-*.js correspondiente (misma
 * convención que interno/config/users.js) — script plano sin módulos,
 * sin build step, expone funciones globales que cada panel usa desde su
 * propia IIFE, igual que ya hace con resolveActiveMarket()/users.js.
 */

var ESTADO_OPERATIVO_LABEL_BASE = {
  en_espera_pago: 'En espera de pago', registrado: 'Registrado',
  en_produccion: 'En producción', completado: 'Completado', cancelada: 'Cancelada',
};
var ESTADO_OPERATIVO_BADGE_BASE = {
  en_espera_pago: 'amber', registrado: 'neutral',
  en_produccion: 'blue', completado: 'green', cancelada: 'red',
};
// RIO-122 (ajuste de UAT, 14/09/2026): Brenda confirmó que el texto largo
// ("... — pendiente de validación" / "... — requiere corrección") se sale
// de la columna de la tabla — la celda no tiene el ancho de un chip de
// pipeline. Acá va SOLO el texto corto que entra en la tabla; el detalle
// de cada pago (panel-*.js, tarjeta de pago) sigue mostrando el contexto
// completo (motivo del rechazo incluido) — nunca se perdió información,
// solo se acortó lo que tiene que entrar en una celda angosta.
var ESTADO_PAGO_EN_ESPERA_LABEL = {
  pendiente: 'En espera de pago',
  informado: 'Pago informado',
  rechazado: 'Pago rechazado',
};
var ESTADO_PAGO_EN_ESPERA_BADGE = { pendiente: 'amber', informado: 'blue', rechazado: 'red' };

// Etiqueta de la columna "Estado" de cualquier tabla de ventas. Nunca una
// sustitución fija de texto: mientras el avance operativo sea
// 'en_espera_pago', se resuelve con el subestado real del pago; en
// cualquier otro avance (ya acreditado en algún momento), se muestra el
// estado operativo real — "Pago confirmado" no necesita texto propio
// porque el avance deja de ser 'en_espera_pago' apenas se acredita.
function estadoVentaVisibleLabel(v) {
  if (v.estadoOperativo === 'en_espera_pago') {
    return ESTADO_PAGO_EN_ESPERA_LABEL[v.estadoPagoResumen] || ESTADO_OPERATIVO_LABEL_BASE.en_espera_pago;
  }
  return ESTADO_OPERATIVO_LABEL_BASE[v.estadoOperativo] || v.estadoOperativo || '—';
}
function estadoVentaVisibleBadge(v) {
  if (v.estadoOperativo === 'en_espera_pago') {
    return ESTADO_PAGO_EN_ESPERA_BADGE[v.estadoPagoResumen] || 'amber';
  }
  return ESTADO_OPERATIVO_BADGE_BASE[v.estadoOperativo] || 'neutral';
}

// Clave de agrupación para chips/contadores de pipeline (Supervisor y
// Administrativo) — separa el balde 'en_espera_pago' en sus 3 subestados
// reales, sin inventar un estado operativo nuevo.
function clavePipeline(v) {
  return v.estadoOperativo === 'en_espera_pago' ? ('pago__' + (v.estadoPagoResumen || 'pendiente')) : v.estadoOperativo;
}
var PIPELINE_LABEL = {
  pago__pendiente: 'En espera de pago',
  pago__informado: 'Pago informado — pendiente de validación',
  pago__rechazado: 'Pago rechazado — requiere corrección',
  registrado: 'Registrado', en_produccion: 'En producción', completado: 'Completado', cancelada: 'Cancelada',
};
var ORDEN_PIPELINE = ['pago__pendiente', 'pago__informado', 'pago__rechazado', 'registrado', 'en_produccion', 'completado', 'cancelada'];
