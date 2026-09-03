// Middleware de /interno/api/personas/* — RIO-119 (segundo bloque,
// 02/09/2026). Mismo enganche que el resto del Portal desde RIO-111/112:
// resuelve context.data.roleIdentity con denegación por defecto — la
// autorización real de cada ruta vive en authz.js, nunca acá.

import { requireRoleIdentity } from '../../../_shared/authz.js';

export const onRequest = requireRoleIdentity;
