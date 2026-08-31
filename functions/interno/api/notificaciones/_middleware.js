// Middleware anidado de /interno/api/notificaciones/* — RIO-116.
// Misma resolución de identidad que el resto del sistema — reutiliza
// authz.js sin duplicar la lógica.

import { requireRoleIdentity } from '../../../_shared/authz.js';

export const onRequest = requireRoleIdentity;
