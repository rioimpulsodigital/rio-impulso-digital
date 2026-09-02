// GET /interno/api/ventas/:id — RIO-112.
// Ficha completa de una venta: venta + cliente + proyecto + componentes.
// Autorización por propiedad/mercado (RIO-97 v2 sección 4/5), nunca por
// nombre propio — misma función assertCanAccessOwner que usará cualquier
// endpoint futuro de detalle (RIO-113+), sin reimplementarla acá.

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { assertCanViewVentaDetalle, AuthzError } from '../../../_shared/authz.js';
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
    `SELECT v.*, c.negocio, c.contacto_nombre, c.telefono, c.email AS cliente_email, c.datos_facturacion_ar,
       u.nombre AS vendedor_nombre, e.nombre AS equipo_nombre, us.nombre AS supervisor_nombre
     FROM ventas v JOIN clientes c ON c.id = v.cliente_id
     LEFT JOIN usuarios u ON u.email = v.vendedor_email
     LEFT JOIN equipos e ON e.id = v.equipo_id
     LEFT JOIN usuarios us ON us.email = v.supervisor_snapshot_email
     WHERE v.id = ?`,
    [params.id]
  );
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);

  try {
    // RIO-118 (corrección — equipos, 01/09/2026): a diferencia del resto
    // de /ventas/:id/* (que siguen usando assertCanAccessOwner, solo por
    // mercado — sus acciones de escritura ya están bloqueadas para un
    // supervisor por permisos propios, no hay fuga real ahí), ESTE
    // endpoint expone el detalle completo (cliente, antecedentes,
    // materiales) y por eso exige además pertenecer al equipo, no solo al
    // mercado, cuando quien mira es un supervisor.
    await assertCanViewVentaDetalle(env.DB, requestId, roleIdentity, venta);
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
  const pagos = await query(env.DB, requestId, 'SELECT * FROM pagos_esperados WHERE venta_id = ? ORDER BY tipo', [venta.id]);

  // RIO-117 (corrección tras validación real, 01/09/2026): datos
  // tributarios/de facturación — nunca automáticos para un supervisor
  // (Brenda: "no recibe automáticamente CUIT/RUT, domicilio de
  // facturación ni datos tributarios"), sin importar que ya pueda ver el
  // resto de la venta por ser de su mismo mercado. Solo el vendedor dueño
  // o administración los ven.
  const esVendedorDueño = roleIdentity.email === venta.vendedor_email;
  const esAdmin = roleIdentity.role === 'admin';
  const puedeVerFacturacion = esVendedorDueño || esAdmin;

  const componentesConMateriales = await Promise.all(componentes.map(async (c) => {
    const informes = await query(
      env.DB, requestId,
      `SELECT m.*, ui.nombre AS informado_por_nombre, ur.nombre AS revisado_por_nombre
       FROM materiales_informados_detalle m
       LEFT JOIN usuarios ui ON ui.email = m.informado_por
       LEFT JOIN usuarios ur ON ur.email = m.revisado_por
       WHERE m.componente_id = ? ORDER BY m.created_at DESC`,
      [c.id]
    );
    const confirmaciones = await query(env.DB, requestId, 'SELECT * FROM materiales_confirmaciones WHERE componente_id = ? ORDER BY created_at DESC', [c.id]);
    const costoDominio = await query(env.DB, requestId, "SELECT monto, nota FROM costos_directos WHERE componente_id = ? AND tipo = 'dominio'", [c.id]);
    const requiereDominio = c.tipo === 'landing' && (venta.producto === 'personalizado' || venta.producto === 'ficha_personalizado');
    return {
      id: c.id,
      tipo: c.tipo,
      // RIO-119: nombre/descripción libres de la fase — null salvo
      // tipo === 'personalizado' (proyectos fuera del catálogo fijo).
      nombre: c.nombre || null,
      descripcion: c.descripcion || null,
      precioIndividualReferencia: c.precio_individual_referencia,
      precioAtribuido: c.precio_atribuido,
      estadoActual: c.estado_actual,
      materialesEstado: c.materiales_estado,
      materialesInformes: informes.map((i) => ({
        id: i.id, informadoPor: i.informado_por,
        // RIO-118 (corrección — identidad visible): nombre para mostrar,
        // resuelto desde D1 — el email sigue siendo el dato real.
        informadoPorNombre: i.informado_por_nombre || null,
        elementos: (() => { try { return JSON.parse(i.elementos_json); } catch (e) { return []; } })(),
        observaciones: i.observaciones, createdAt: i.created_at,
        // RIO-118 (corrección funcional — materiales por correo central,
        // 01/09/2026): cada entrega es su propio registro inmutable, con
        // su propio estado de revisión — nunca reemplaza al anterior.
        numeroEntrega: i.numero_entrega,
        descripcion: i.descripcion,
        cantidadArchivosAprox: i.cantidad_archivos_aprox,
        correoDestino: i.correo_destino,
        estadoRevision: i.estado_revision,
        revisadoPor: i.revisado_por,
        revisadoPorNombre: i.revisado_por_nombre || null,
        revisadoEn: i.revisado_en,
        motivoRevision: i.motivo_revision,
      })),
      materialesConfirmaciones: confirmaciones.map((cf) => ({
        id: cf.id, adminEmail: cf.admin_email, resultado: cf.resultado,
        faltantes: cf.faltantes_json ? (() => { try { return JSON.parse(cf.faltantes_json); } catch (e) { return []; } })() : [],
        createdAt: cf.created_at,
      })),
      // Solo tiene sentido en la Landing de un plan con dominio propio
      // incluido (Premium) — el resto de los componentes nunca lo necesita.
      costoDominioPendiente: requiereDominio && costoDominio.length === 0,
    };
  }));

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
        vendedorEmail: venta.vendedor_email,
        vendedorNombre: venta.vendedor_nombre || null,
        estadoActual: venta.estado_actual,
        createdAt: venta.created_at,
        // RIO-118 (corrección — ventas administrativas y comisión de
        // supervisión, 01/09/2026): snapshot inmutable tomado al cerrar
        // la venta — "Equipo no asignado" (equipoId null, tipoVenta
        // 'equipo' por default) es un vacío estructural histórico o de un
        // vendedor sin equipo; "directa_administracion_sin_supervision"
        // es SIEMPRE una elección deliberada de administración, con su
        // propio motivo — el frontend nunca confunde ambos casos.
        tipoVenta: venta.tipo_venta,
        equipoId: venta.equipo_id || null,
        equipoNombre: venta.equipo_nombre || null,
        supervisorEmail: venta.supervisor_snapshot_email || null,
        supervisorNombre: venta.supervisor_nombre || null,
        planSupervisionSnapshotId: venta.plan_supervision_snapshot_id || null,
        supervisionAplica: !!venta.supervision_aplica,
        motivoSinSupervision: venta.motivo_sin_supervision || null,
        porcentajeSupervisionAplicado: venta.porcentaje_supervision_aplicado,
        porcentajeFinalEmpresa: venta.porcentaje_final_empresa,
        // RIO-119 (ampliación de alcance — proyectos personalizados,
        // 02/09/2026): null salvo producto === 'proyecto_personalizado'.
        nombreProyecto: venta.nombre_proyecto || null,
        descripcionProyecto: venta.descripcion_proyecto || null,
        notionUrl: venta.notion_url || null,
        // RIO-117 (corrección tras validación real): categorizado, nunca
        // repite lo que ya está en cabecera (cliente/producto/mercado/
        // precio) — ver Kit para el detalle de qué llena cada categoría.
        // Redactado igual que datosFacturacionAr: la categoría
        // "facturacion" (si el Kit la incluyó) desaparece para un
        // supervisor que no es ni el vendedor ni admin.
        antecedentesKit: (() => {
          if (!venta.antecedentes_kit_json) return null;
          let parsed;
          try { parsed = JSON.parse(venta.antecedentes_kit_json); } catch (e) { return null; }
          if (!puedeVerFacturacion && parsed && typeof parsed === 'object') {
            const { facturacion, ...resto } = parsed;
            return resto;
          }
          return parsed;
        })(),
      },
      cliente: {
        id: venta.cliente_id,
        negocio: venta.negocio,
        contactoNombre: venta.contacto_nombre,
        telefono: venta.telefono,
        email: venta.cliente_email,
        datosFacturacionAr: puedeVerFacturacion ? venta.datos_facturacion_ar : null,
      },
      proyecto: proyecto ? { id: proyecto.id, codigoProyecto: proyecto.codigo_proyecto, estadoActual: proyecto.estado_actual } : null,
      componentes: componentesConMateriales,
      pagosEsperados: pagos.map((p) => ({
        id: p.id,
        tipo: p.tipo,
        etiqueta: p.etiqueta || null,
        monto: p.monto,
        moneda: p.moneda,
        estado: p.estado,
      })),
    },
    requestId
  );
}
