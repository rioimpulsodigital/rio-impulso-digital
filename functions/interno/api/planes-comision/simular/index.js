// POST /interno/api/planes-comision/simular — RIO-119 (tercer bloque, item
// 4, 02/09/2026). Exclusivo de administración.
//
// Valida una distribución económica EFECTIVA antes de guardar nada — "que
// el administrador pueda simular la distribución efectiva antes de
// guardar" y "mostrar claramente qué recibe cada participante y qué queda
// para la empresa". No toca la base de datos: es una función pura sobre lo
// que el admin arma en el formulario (participaciones ya resueltas a un
// beneficiario, o null cuando todavía falta asignar a alguien).

import { ok, Errors } from '../../../../_shared/response.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../_shared/security.js';
import { validarDistribucion } from '../../../../_shared/comisiones.js';

export async function onRequest(context) {
  const { request, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);
  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  const participaciones = body?.participaciones;
  if (!Array.isArray(participaciones) || participaciones.length === 0) {
    return Errors.validation('Falta participaciones (arreglo no vacío).', requestId);
  }
  for (const p of participaciones) {
    if (typeof p?.concepto !== 'string' || !p.concepto.trim()) return Errors.validation('Cada participación requiere un concepto.', requestId);
    if (typeof p.porcentaje !== 'number') return Errors.validation(`Falta porcentaje numérico para "${p.concepto}".`, requestId);
  }

  const resultado = validarDistribucion(participaciones);
  return ok(resultado, requestId);
}
