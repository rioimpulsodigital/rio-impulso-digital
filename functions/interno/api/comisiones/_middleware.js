// Middleware anidado de /interno/api/comisiones/* — RIO-114.
// Misma resolución de identidad que /interno/api/ventas/* — reutiliza
// authz.js sin duplicar la lógica.

import { requireRoleIdentity } from '../../../_shared/authz.js';

export const onRequest = requireRoleIdentity;
