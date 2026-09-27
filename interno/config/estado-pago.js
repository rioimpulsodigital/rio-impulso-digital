/*
 * Estado visible del pago — RIO-122 (13/09/2026, segunda corrección de UAT;
 * columnas separadas, 17/09/2026 a pedido de Brenda).
 *
 * Única fuente de las etiquetas/badges que traducen `estadoOperativo` +
 * `estadoPagoResumen` (ambos ya calculados por el servidor, ver
 * functions/interno/api/ventas/index.js y [id].js) a lo que ve el usuario
 * en las columnas "Estado producto" y "Estado pago" de cualquier tabla de
 * ventas — panel-vendedor.js, panel-supervisor.js, panel-administrativo.js.
 *
 * 17/09/2026: antes había una única columna "Estado" que, mientras
 * estadoOperativo era 'en_espera_pago', mostraba el subestado de pago en
 * su lugar (ver estadoVentaVisibleLabel/Badge, retiradas) — mezclaba dos
 * conceptos en un solo badge. Ahora son siempre dos columnas
 * independientes: estadoProductoLabel/Badge (avance real del producto,
 * nunca sustituido) y estadoPagoLabel/Badge (subestado real del pago,
 * siempre válido, no solo mientras el producto espera el pago).
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

// RIO-122 (UAT Negocio Test 14B, 15/09/2026, hallazgos 6/8/9):
// 'en_espera_aprobacion' — la producción terminó, se está esperando la
// decisión del cliente (nunca se confunde con "todavía en producción").
// 'pendiente_cierre' — el cliente ya aprobó, pero el cierre
// administrativo/financiero (comisión) todavía no está pagado — nunca se
// confunde con "Completado" antes de tiempo. Ver
// calcularRollupProyecto en functions/_shared/proyectos.js.
// RIO-122 (ajuste de UAT, 15/09/2026): texto corto para la columna
// angosta de la tabla — mismo criterio ya aplicado a los subestados de
// pago (Brenda: el texto largo se sale de la columna). El identificador
// interno estable sigue siendo 'en_espera_aprobacion'/'pendiente_cierre'
// — solo cambia el texto mostrado.
var ESTADO_OPERATIVO_LABEL_BASE = {
  en_espera_pago: 'En espera de pago', registrado: 'Registrado',
  en_produccion: 'En producción', en_espera_aprobacion: 'Espera aprobación',
  pendiente_cierre: 'Pendiente cierre', completado: 'Completado', cancelada: 'Cancelada',
};
var ESTADO_OPERATIVO_BADGE_BASE = {
  en_espera_pago: 'amber', registrado: 'neutral',
  en_produccion: 'blue', en_espera_aprobacion: 'amber',
  pendiente_cierre: 'amber', completado: 'green', cancelada: 'red',
};
// RIO-122 (corrección solicitada por Brenda, 17/09/2026): "Estado producto"
// y "Estado pago" pasan a ser dos columnas SIEMPRE independientes en la
// tabla principal de los 3 paneles — antes, mientras estadoOperativo era
// 'en_espera_pago', una única columna "Estado" mostraba el subestado del
// pago en lugar del avance operativo (ver estadoVentaVisibleLabel/Badge,
// ya retiradas). Eso mezclaba dos conceptos en un solo badge, exactamente
// lo que esta corrección prohíbe. Ahora cada concepto tiene su propia
// fuente, siempre válida, sin casos especiales entre sí.

// Estado producto: SIEMPRE el avance operativo real (calcularEstadoOperativo
// en functions/interno/api/ventas/index.js), nunca sustituido por el
// subestado de pago. Mientras el avance sea 'en_espera_pago', esta columna
// sigue diciendo "En espera de pago" — es el estado real del producto, que
// legítimamente no arranca hasta que el pago se acredita (RIO-117) — y la
// columna "Estado pago" (más abajo) muestra en paralelo el subestado real
// del pago, sin que ninguna de las dos tape a la otra.
function estadoProductoLabel(v) {
  return ESTADO_OPERATIVO_LABEL_BASE[v.estadoOperativo] || v.estadoOperativo || '—';
}
function estadoProductoBadge(v) {
  return ESTADO_OPERATIVO_BADGE_BASE[v.estadoOperativo] || 'neutral';
}

// Estado pago: exclusivamente `estadoPagoResumen`, válido siempre — no solo
// mientras estadoOperativo sea 'en_espera_pago'. Una vez acreditado, esta
// columna sigue diciendo "Acreditado" aunque el producto ya haya avanzado a
// producción, aprobación, cierre o completado — nunca deja de mostrarse.
// RIO-122 (ajuste de UAT, 14/09/2026): Brenda confirmó que el texto largo
// ("... — pendiente de validación" / "... — requiere corrección") se sale
// de la columna de la tabla — la celda no tiene el ancho de un chip de
// pipeline. Acá va SOLO el texto corto que entra en la tabla; el detalle
// de cada pago (panel-*.js, tarjeta de pago) sigue mostrando el contexto
// completo (motivo del rechazo incluido) — nunca se perdió información,
// solo se acortó lo que tiene que entrar en una celda angosta.
var ESTADO_PAGO_LABEL = {
  pendiente: 'En espera de pago',
  informado: 'Pago informado',
  rechazado: 'Pago rechazado',
  acreditado: 'Acreditado',
};
var ESTADO_PAGO_BADGE = { pendiente: 'amber', informado: 'blue', rechazado: 'red', acreditado: 'green' };
function estadoPagoLabel(v) {
  return ESTADO_PAGO_LABEL[v.estadoPagoResumen] || ESTADO_PAGO_LABEL.pendiente;
}
function estadoPagoBadge(v) {
  return ESTADO_PAGO_BADGE[v.estadoPagoResumen] || 'amber';
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
  registrado: 'Registrado', en_produccion: 'En producción',
  en_espera_aprobacion: 'En espera de aprobación del cliente',
  pendiente_cierre: 'Pendiente de cierre administrativo/financiero',
  completado: 'Completado', cancelada: 'Cancelada',
};
var ORDEN_PIPELINE = [
  'pago__pendiente', 'pago__informado', 'pago__rechazado', 'registrado',
  'en_produccion', 'en_espera_aprobacion', 'pendiente_cierre', 'completado', 'cancelada',
];
