// Middleware anidado de /interno/api/ventas/* — RIO-112.
// Misma resolución de identidad que /interno/api/identidad/* (RIO-111) —
// reutiliza authz.js sin duplicar la lógica. Ver ese middleware para el
// detalle de por qué esto no vive en el middleware padre.

import { requireRoleIdentity } from '../../../_shared/authz.js';

export const onRequest = requireRoleIdentity;
