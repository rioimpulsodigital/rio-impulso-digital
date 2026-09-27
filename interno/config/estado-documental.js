/*
 * Estado documental de una liquidación — RIO-122 (22/09/2026, corrección de
 * presentación tras UAT de Liquidaciones).
 *
 * Única fuente de las etiquetas/badges que traducen `estadoDocumental`
 * (calculado por el servidor, ver calcularEstadoDocumentalLiquidacion en
 * functions/_shared/comprobantes.js) a lo que ve el usuario en Panel
 * Administrativo y Panel Vendedor. El valor que llega desde la API
 * (sin_comprobantes | conversion_documentada | transferencia_documentada |
 * documentacion_completa | rechazado_pendiente_reemplazo) sigue siendo
 * contrato interno entre backend y frontend — nunca se muestra crudo en
 * pantalla, solo se traduce acá.
 *
 * Antes ESTADO_DOCUMENTAL_LABEL/BADGE existían únicamente dentro de
 * panel-administrativo.js. Panel Vendedor ("Ver liquidación", RIO-122 UAT
 * real del 21/09/2026) mostraba el valor sin traducir
 * ("documentacion_completa") porque nunca tuvo acceso a ese mapa — se
 * centraliza acá, mismo patrón ya usado por interno/config/estado-pago.js
 * (que resuelve estadoOperativo/estadoPagoResumen), para que no vuelva a
 * divergir entre paneles.
 *
 * Cargar este script ANTES del panel-*.js correspondiente (misma
 * convención que interno/config/estado-pago.js y users.js) — script plano
 * sin módulos, sin build step, expone variables globales que cada panel
 * lee directamente desde su propia IIFE.
 */

var ESTADO_DOCUMENTAL_LABEL = {
  sin_comprobantes: 'Sin comprobantes', conversion_documentada: 'Conversión documentada',
  transferencia_documentada: 'Transferencia documentada', documentacion_completa: 'Documentación completa',
  rechazado_pendiente_reemplazo: 'Comprobante rechazado — pendiente reemplazo',
};
var ESTADO_DOCUMENTAL_BADGE = {
  sin_comprobantes: 'neutral', conversion_documentada: 'blue', transferencia_documentada: 'blue',
  documentacion_completa: 'green', rechazado_pendiente_reemplazo: 'red',
};
