// Middleware anidado de /interno/api/identidad/* — RIO-111.
// Cloudflare Pages Functions encadena los _middleware.js del más externo al
// más interno: este corre DESPUÉS de functions/interno/api/_middleware.js
// (que ya validó el JWT de Access — RIO-110 sección 8) y ANTES de cada ruta
// de esta carpeta.
//
// La resolución en sí (email verificado → rol/mercados/permisos en D1, con
// denegación por defecto) vive en authz.js (`requireRoleIdentity`) — RIO-112
// reutiliza exactamente la misma función para /interno/api/ventas/*, así
// que este archivo es solo el punto de enganche para esta carpeta.
//
// Por qué es un middleware separado y no parte del middleware padre: el
// endpoint técnico /interno/api/health (RIO-110) debe seguir funcionando
// solo con Access válido, sin depender de que quien lo llame esté
// registrado en el modelo de negocio de RIO-111/112 — son capas distintas.

import { requireRoleIdentity } from '../../../_shared/authz.js';

export const onRequest = requireRoleIdentity;
