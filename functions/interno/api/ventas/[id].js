// GET /interno/api/ventas/:id — RIO-112.
// Ficha completa de una venta: venta + cliente + proyecto + componentes.
// Autorización por propiedad/mercado (RIO-97 v2 sección 4/5), nunca por
// nombre propio — misma función assertCanAccessOwner que usará cualquier
// endpoint futuro de detalle (RIO-113+), sin reimplementarla acá.

import { ok, Errors } from '../../../_shared/response.js';
import { query } from '../../../_shared/db.js';
import { assertCanViewVentaDetalle, AuthzError } from '../../../_shared/authz.js';
import { isMethodAllowed } from '../../../_shared/security.js';
import { calcularEstadoOperativo } from './index.js';

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
    ? await query(env.DB, requestId, 'SELECT * FROM componentes WHERE proyecto_id = ? ORDER BY orden IS NULL, orden ASC, tipo ASC', [proyecto.id])
    : [];
  const pagos = await query(env.DB, requestId, 'SELECT * FROM pagos_esperados WHERE venta_id = ? ORDER BY tipo', [venta.id]);
  // RIO-122 (corrección de presentación, 13/09/2026): un pago rechazado
  // vuelve a estado 'pendiente' (rechazarPago) — indistinguible de "nunca
  // informado" mirando solo `pagos_esperados.estado`. La única señal real
  // es que ya existe historial para ese pago (informarPago/rechazarPago
  // ya escribieron un evento); si el vendedor lo vuelve a informar, el
  // pago pasa a 'informado' y esto deja de aplicar solo, sin ningún flag
  // extra que mantener sincronizado.
  const pagosConHistorial = pagos.length
    ? new Set(
        (await query(
          env.DB, requestId,
          `SELECT DISTINCT entidad_id FROM eventos_historial WHERE entidad = 'pago' AND entidad_id IN (${pagos.map(() => '?').join(',')})`,
          pagos.map((p) => p.id)
        )).map((r) => r.entidad_id)
      )
    : new Set();
  // RIO-122 (corrección de causa raíz, 15/09/2026): la ficha no exponía
  // ningún estado operativo propio — mostraba directamente
  // `proyecto.estado_actual` en crudo (ver más abajo, campo `proyecto`),
  // que solo se recalcula en algunas transiciones (ver proyectos.js).
  // Acá se calcula el mismo `estadoOperativo` que ya usa la tabla
  // (GET /ventas), reutilizando la MISMA función — nunca una segunda
  // implementación — a partir de los mismos tres hechos: avance real del
  // proyecto, si algún pago está acreditado, si existe una cancelación.
  const cancelacionRows = await query(
    env.DB, requestId,
    "SELECT COUNT(*) AS total FROM incidencias WHERE venta_id = ? AND tipo = 'cancelacion'",
    [venta.id]
  );
  const pagosAcreditadosCount = pagos.filter((p) => p.estado === 'acreditado').length;
  const estadoOperativo = proyecto
    ? calcularEstadoOperativo({
        proyecto_estado: proyecto.estado_actual,
        pagos_acreditados_count: pagosAcreditadosCount,
        cancelacion_count: cancelacionRows[0]?.total || 0,
      })
    : null;
  // RIO-122: mismo resumen de pago que ya calcula GET /ventas por SQL
  // (pendiente | informado | rechazado | acreditado) — acá se deriva en
  // JS a partir de `pagos`/`pagosConHistorial`, que este endpoint ya tenía
  // en memoria; misma regla exacta, nunca una tercera fuente.
  const estadoPagoResumen = (() => {
    if (pagos.length === 0) return 'pendiente';
    if (pagos.every((p) => p.estado === 'acreditado')) return 'acreditado';
    if (pagos.some((p) => p.estado === 'informado' || p.estado === 'acreditado')) return 'informado';
    if (pagos.some((p) => p.estado === 'pendiente' && pagosConHistorial.has(p.id))) return 'rechazado';
    return 'pendiente';
  })();
  // RIO-119 (tercer bloque, item 5, 03/09/2026): "próxima acción y
  // responsable" ya se registra por evento (historial.js) — se expone acá
  // la más reciente en vez de duplicar el dato en la venta.
  const proximaAccionRows = await query(
    env.DB, requestId,
    "SELECT proxima_accion, responsable_proxima_accion FROM eventos_historial WHERE venta_id = ? AND proxima_accion IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    [venta.id]
  );

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
      // RIO-119 (tercer bloque, item 5, 03/09/2026): metadata de gestión
      // de fase — null en componentes de catálogo que nunca la usaron.
      orden: c.orden ?? null,
      responsableOperativoEmail: c.responsable_operativo_email || null,
      fechaPrevista: c.fecha_prevista || null,
      fechaReal: c.fecha_real || null,
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
        // RIO-122 (corrección de causa raíz, 15/09/2026): mismos campos y
        // mismo cálculo que ya expone GET /ventas — permite que la ficha
        // muestre "Estado operativo/producción" con la fuente única
        // compartida (interno/config/estado-pago.js), nunca desalineada
        // de lo que ya muestra la tabla para esta misma venta.
        estadoOperativo,
        estadoPagoResumen,
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
        // RIO-119 (cierre técnico — verificación de exposición del Portal
        // del Vendedor, 10/09/2026): el % de empresa nunca es visible fuera
        // de administración — mismo criterio que ya aplica `/distribucion`
        // (exclusivo de manageUsers). El vendedor/supervisor nunca lo
        // necesitó (panel-vendedor.js nunca lo lee), pero hasta ahora el
        // valor viajaba igual en el JSON crudo de este endpoint — corregido
        // acá, redactado a null para cualquier rol que no sea admin.
        porcentajeFinalEmpresa: esAdmin ? venta.porcentaje_final_empresa : null,
        // RIO-119 (ampliación de alcance — proyectos personalizados,
        // 02/09/2026): null salvo producto === 'proyecto_personalizado'.
        nombreProyecto: venta.nombre_proyecto || null,
        descripcionProyecto: venta.descripcion_proyecto || null,
        notionUrl: venta.notion_url || null,
        // RIO-119 (tercer bloque, item 5, 02/09/2026): snapshot INMUTABLE
        // de la distribución aprobada al registrar el proyecto — nunca se
        // recalcula después.
        // RIO-119 (cierre técnico, 10/09/2026): igual que arriba, redactado
        // a null fuera de administración — incluye la distribución
        // completa (pools de comercial/supervisión/desarrollo, cada
        // participación con su % y beneficiario) y el % de empresa del
        // proyecto, exactamente lo que Brenda pidió que el Portal del
        // Vendedor nunca exponga. El detalle propio de cada participación
        // ya se resuelve por `/ventas/:id/comisiones`, que SÍ filtra a
        // "solo lo mío" — esta ruta nunca reemplazó a esa.
        distribucionSnapshot: esAdmin && venta.distribucion_snapshot ? JSON.parse(venta.distribucion_snapshot) : null,
        // RIO-119 (tercer bloque, item 5, 03/09/2026): 'referencia' o
        // 'reconstruccion' — null en cualquier venta del flujo normal.
        modoHistorico: venta.modo_historico || null,
        proximaAccion: proximaAccionRows[0]?.proxima_accion || null,
        responsableProximaAccion: proximaAccionRows[0]?.responsable_proxima_accion || null,
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
        // RIO-119 (quinto bloque, 04/09/2026): condición 3 de la
        // liberación de una participación de proyecto personalizado —
        // null/false en cualquier pago de catálogo que nunca la usó.
        hitoValidado: !!p.hito_validado,
        hitoValidadoPor: p.hito_validado_por || null,
        hitoValidadoAt: p.hito_validado_at || null,
        hitoNota: p.hito_nota || null,
        // RIO-122: distingue "rechazado, esperando corrección" de "nunca
        // informado" — ambos comparten estado 'pendiente' en D1.
        fueRechazado: p.estado === 'pendiente' && pagosConHistorial.has(p.id),
      })),
    },
    requestId
  );
}
