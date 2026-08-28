// GET /interno/api/ventas/:id — RIO-112.
// Ficha completa de una venta: venta + cliente + proyecto + componentes.
// Autorización por propiedad/mercado (RIO-97 v2 sección 4/5), nunca por
// nombre propio — misma función assertCanAccessOwner que usará cualquier
// endpoint futuro de detalle (RIO-113+), sin reimplementarla acá.

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { assertCanAccessOwner, AuthzError } from '../../../_shared/authz.js';
import { isMethodAllowed } from '../../../_shared/security.js';

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET'])) {
    return Errors.methodNotAllowed(requestId);
  }

  const ventaRows = await query(
    env.DB,
    requestId,
    `SELECT v.*, c.negocio, c.contacto_nombre, c.telefono, c.email AS cliente_email, c.datos_facturacion_ar
     FROM ventas v JOIN clientes c ON c.id = v.cliente_id
     WHERE v.id = ?`,
    [params.id]
  );
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    assertCanAccessOwner(roleIdentity, venta.ejecutivo_email, venta.mercado);
  } catch (e) {
    if (e instanceof AuthzError) {
      // Nunca se distingue "no existe" de "no autorizado" — ambos casos
      // devuelven lo mismo hacia afuera para no confirmar la existencia de
      // una venta ajena por descarte (mismo criterio que whoami/usuarios).
      return Errors.notFound(requestId);
    }
    throw e;
  }

  const proyectoRows = await query(env.DB, requestId, 'SELECT * FROM proyectos WHERE venta_id = ?', [venta.id]);
  const proyecto = proyectoRows[0] || null;
  const componentes = proyecto
    ? await query(env.DB, requestId, 'SELECT * FROM componentes WHERE proyecto_id = ? ORDER BY tipo', [proyecto.id])
    : [];

  return ok(
    {
      venta: {
        id: venta.id,
        codigoVenta: venta.codigo_venta,
        mercado: venta.mercado,
        producto: venta.producto,
        moneda: venta.moneda,
        tipoPrecio: venta.tipo_precio,
        precioPactado: venta.precio_pactado,
        ejecutivoEmail: venta.ejecutivo_email,
        estadoActual: venta.estado_actual,
        createdAt: venta.created_at,
      },
      cliente: {
        id: venta.cliente_id,
        negocio: venta.negocio,
        contactoNombre: venta.contacto_nombre,
        telefono: venta.telefono,
        email: venta.cliente_email,
        datosFacturacionAr: venta.datos_facturacion_ar,
      },
      proyecto: proyecto ? { id: proyecto.id, codigoProyecto: proyecto.codigo_proyecto, estadoActual: proyecto.estado_actual } : null,
      componentes: componentes.map((c) => ({
        id: c.id,
        tipo: c.tipo,
        precioIndividualReferencia: c.precio_individual_referencia,
        precioAtribuido: c.precio_atribuido,
        estadoActual: c.estado_actual,
      })),
    },
    requestId
  );
}
