// Formato JSON uniforme de respuestas y errores — RIO-110 sección 10.
//
// Toda respuesta de /interno/api/* tiene la forma:
//   { ok: true,  data: <objeto>, error: null,   requestId: "<uuid>" }
//   { ok: false, data: null,     error: {code, message}, requestId: "<uuid>" }
//
// `message` en errores es siempre un texto seguro para mostrar al usuario —
// nunca un stack trace, una consulta SQL ni un detalle interno de Cloudflare.

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function newRequestId() {
  return crypto.randomUUID();
}

function jsonResponse(body, status, requestId, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extraHeaders,
      'X-Request-Id': requestId,
    },
  });
}

export function ok(data, requestId, status = 200, extraHeaders = {}) {
  return jsonResponse({ ok: true, data, error: null, requestId }, status, requestId, extraHeaders);
}

// code: string estable en MAYUSCULAS_CON_GUIONES_BAJOS (para que el frontend pueda
// distinguir casos sin parsear el mensaje). message: texto en español, seguro de mostrar.
export function fail(code, message, status, requestId, extraHeaders = {}) {
  return jsonResponse({ ok: false, data: null, error: { code, message }, requestId }, status, requestId, extraHeaders);
}

export const Errors = {
  unauthenticated: (requestId, extraHeaders) =>
    fail('UNAUTHENTICATED', 'No se pudo verificar tu identidad. Iniciá sesión nuevamente.', 401, requestId, extraHeaders),
  methodNotAllowed: (requestId, extraHeaders) =>
    fail('METHOD_NOT_ALLOWED', 'Método no permitido para esta ruta.', 405, requestId, extraHeaders),
  notFound: (requestId, extraHeaders) =>
    fail('NOT_FOUND', 'Recurso no encontrado.', 404, requestId, extraHeaders),
  validation: (message, requestId, extraHeaders) =>
    fail('VALIDATION_ERROR', message || 'Solicitud inválida.', 400, requestId, extraHeaders),
  internal: (requestId, extraHeaders) =>
    fail('INTERNAL_ERROR', 'Ocurrió un error interno. Si persiste, contactá a soporte con este identificador.', 500, requestId, extraHeaders),
  serviceUnavailable: (requestId, extraHeaders) =>
    fail('SERVICE_UNAVAILABLE', 'El servicio no está disponible en este momento.', 503, requestId, extraHeaders),
};
