// Middleware anidado de /interno/api/equipos/* — RIO-118 (corrección,
// ventas administrativas y comisión de supervisión, 01/09/2026). Mismo
// patrón que identidad/ y ventas/: resuelve roleIdentity desde D1, con
// denegación por defecto (RIO-111/112).

import { requireRoleIdentity } from '../../../_shared/authz.js';

export const onRequest = requireRoleIdentity;
