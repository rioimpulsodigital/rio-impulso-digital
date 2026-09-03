// GET/POST /interno/api/ventas/:id/distribucion — RIO-119 (tercer bloque,
// item 5, 03/09/2026). Exclusivo de administración (misma capacidad que
// gestiona planes de comisión y personas — esto es compensación de
// personas, nunca visible para supervisor/vendedor/asistente, sin importar
// si son dueños de la venta).
//
// Solo aplica a producto === 'proyecto_personalizado' — el catálogo sigue
// resolviéndose como siempre vía planes_comision + asignaciones_plan_comision.
//
// Modelo: una venta tiene una distribución VIGENTE (la de mayor versión
// que no esté 'reemplazada') con 3 pools fijos (comercial/supervisión/
// desarrollo, copiados de una plantilla o definidos a mano) — "empresa"
// nunca se guarda, siempre es 100 menos esos tres. Dentro de cada pool,
// administración carga participaciones concretas (beneficiario + %,
// opcionalmente atadas a una fase) — puede dejarlas sin beneficiario
// ("Pendiente de asignación") mientras prepara el proyecto. 'activar'
// exige que TODO el pool de cada concepto esté asignado a beneficiarios
// reales (validarActivacionProyecto) y congela un snapshot inmutable en
// ventas.distribucion_snapshot. Un cambio posterior a una distribución ya
// confirmada exige pasar por 'corregir' (motivo obligatorio, auditado) —
// nunca se edita una fila 'confirmada' in place.

import { ok, Errors } from '../../../../../_shared/response.js';
import { query, execute, transaction } from '../../../../../_shared/db.js';
import { isMethodAllowed, hasExpectedContentType } from '../../../../../_shared/security.js';
import { logEvento } from '../../../../../_shared/historial.js';
import { validarActivacionProyecto, generarComisionesDesdeDistribucion, registrarFinanzasEmpresa } from '../../../../../_shared/comisiones.js';

function serializeParticipacion(row) {
  return {
    id: row.id,
    concepto: row.concepto,
    faseId: row.fase_id || null,
    beneficiarioEmail: row.beneficiario_email || null,
    porcentaje: row.porcentaje,
    note: row.note || null,
    createdAt: row.created_at,
  };
}

function serializeDistribucion(row) {
  return {
    id: row.id,
    version: row.version,
    estado: row.estado,
    plantillaId: row.plantilla_id || null,
    pools: { comercial: row.porcentaje_comercial, supervision: row.porcentaje_supervision, desarrollo: row.porcentaje_desarrollo },
    motivoCorreccion: row.motivo_correccion || null,
    confirmedAt: row.confirmed_at || null,
    confirmedBy: row.confirmed_by || null,
    politicaLiberacion: row.politica_liberacion || null,
    requiereHitoValidado: !!row.requiere_hito_validado,
    plazoResguardo: row.plazo_resguardo_activo
      ? { activo: true, dias: row.plazo_resguardo_dias, tipoDias: row.plazo_resguardo_tipo_dias, eventoInicio: row.plazo_resguardo_evento_inicio, alcance: row.plazo_resguardo_alcance }
      : { activo: false },
    costosCerrados: !!row.costos_cerrados,
    costosCerradosPor: row.costos_cerrados_por || null,
    costosCerradosAt: row.costos_cerrados_at || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function distribucionVigente(db, requestId, ventaId) {
  const rows = await query(
    db, requestId,
    "SELECT * FROM venta_distribuciones WHERE venta_id = ? AND estado != 'reemplazada' ORDER BY version DESC LIMIT 1",
    [ventaId]
  );
  return rows[0] || null;
}

export async function onRequest(context) {
  const { request, env, params, data } = context;
  const { requestId, roleIdentity } = data;

  if (!isMethodAllowed(request, ['GET', 'POST'])) return Errors.methodNotAllowed(requestId);
  if (!roleIdentity.permissions.manageUsers) return Errors.forbidden(requestId);

  const ventaRows = await query(env.DB, requestId, "SELECT id, producto FROM ventas WHERE id = ?", [params.id]);
  const venta = ventaRows[0];
  if (!venta) return Errors.notFound(requestId);
  if (venta.producto !== 'proyecto_personalizado') {
    return Errors.validation('La distribución económica propia solo aplica a proyectos personalizados.', requestId);
  }

  if (request.method === 'GET') {
    const distribucion = await distribucionVigente(env.DB, requestId, venta.id);
    if (!distribucion) return ok({ distribucion: null, participaciones: [], resumen: null, comisiones: [], finanzasEmpresa: null }, requestId);
    const participacionRows = await query(env.DB, requestId, 'SELECT * FROM venta_participaciones WHERE distribucion_id = ? ORDER BY concepto ASC, created_at ASC', [distribucion.id]);
    const resumen = validarActivacionProyecto(
      { comercial: distribucion.porcentaje_comercial, supervision: distribucion.porcentaje_supervision, desarrollo: distribucion.porcentaje_desarrollo },
      participacionRows.map((p) => ({ concepto: p.concepto, beneficiarioEmail: p.beneficiario_email, porcentaje: p.porcentaje, faseId: p.fase_id }))
    );

    const comisionRows = await query(env.DB, requestId, 'SELECT * FROM comisiones WHERE distribucion_id = ? ORDER BY created_at ASC', [distribucion.id]);
    const finanzasRows = await query(env.DB, requestId, 'SELECT * FROM proyecto_finanzas_empresa WHERE distribucion_id = ? ORDER BY created_at DESC', [distribucion.id]);

    return ok({
      distribucion: serializeDistribucion(distribucion),
      participaciones: participacionRows.map(serializeParticipacion),
      resumen,
      comisiones: comisionRows.map((c) => ({
        id: c.id, tipo: c.tipo, beneficiarioEmail: c.beneficiario_email, porcentajeSnapshot: c.porcentaje_snapshot,
        baseSnapshot: c.base_snapshot, montoBase: c.monto_base, moneda: c.moneda, montoComision: c.monto_comision,
        estado: c.estado, esEstimacion: !!c.es_estimacion, componenteId: c.componente_id || null,
      })),
      finanzasEmpresa: finanzasRows[0] ? {
        id: finanzasRows[0].id, montoBruto: finanzasRows[0].monto_bruto, costosDirectos: finanzasRows[0].costos_directos,
        utilidadNeta: finanzasRows[0].utilidad_neta, porcentajeEmpresa: finanzasRows[0].porcentaje_empresa,
        montoEmpresa: finanzasRows[0].monto_empresa, fondosObtenidos: finanzasRows[0].fondos_obtenidos,
        fondosEstimadosPendientes: finanzasRows[0].monto_empresa - finanzasRows[0].fondos_obtenidos,
        moneda: finanzasRows[0].moneda, esEstimacion: !!finanzasRows[0].es_estimacion, createdAt: finanzasRows[0].created_at,
      } : null,
    }, requestId);
  }

  if (!hasExpectedContentType(request)) return Errors.validation('Content-Type debe ser application/json.', requestId);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Errors.validation('El cuerpo de la solicitud no es JSON válido.', requestId);
  }

  if (body?.action === 'definir-pools') {
    let { plantillaId, porcentajeComercial, porcentajeSupervision, porcentajeDesarrollo } = body;
    if (plantillaId) {
      const plantillaRows = await query(env.DB, requestId, 'SELECT * FROM plantillas_distribucion WHERE id = ?', [plantillaId]);
      const plantilla = plantillaRows[0];
      if (!plantilla) return Errors.validation('La plantilla indicada no existe.', requestId);
      if (porcentajeComercial === undefined) porcentajeComercial = plantilla.porcentaje_comercial;
      if (porcentajeSupervision === undefined) porcentajeSupervision = plantilla.porcentaje_supervision;
      if (porcentajeDesarrollo === undefined) porcentajeDesarrollo = plantilla.porcentaje_desarrollo;
    }
    for (const [campo, valor] of [['porcentajeComercial', porcentajeComercial], ['porcentajeSupervision', porcentajeSupervision], ['porcentajeDesarrollo', porcentajeDesarrollo]]) {
      if (!Number.isInteger(valor) || valor < 0 || valor > 100) return Errors.validation(`${campo} debe ser un entero entre 0 y 100 (directo, o resuelto desde la plantilla).`, requestId);
    }
    if (porcentajeComercial + porcentajeSupervision + porcentajeDesarrollo > 100) {
      return Errors.validation('comercial + supervisión + desarrollo no puede superar 100 (el resto queda para empresa).', requestId);
    }

    let vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (vigente && vigente.estado === 'confirmada') {
      return Errors.conflict('DISTRIBUCION_CONFIRMADA', 'Esta distribución ya está confirmada — usá la acción "corregir" para modificarla.', requestId);
    }

    if (vigente) {
      await execute(
        env.DB, requestId,
        'UPDATE venta_distribuciones SET plantilla_id = ?, porcentaje_comercial = ?, porcentaje_supervision = ?, porcentaje_desarrollo = ? WHERE id = ?',
        [plantillaId || null, porcentajeComercial, porcentajeSupervision, porcentajeDesarrollo, vigente.id]
      );
      return ok({ id: vigente.id }, requestId);
    }

    const id = crypto.randomUUID();
    await execute(
      env.DB, requestId,
      `INSERT INTO venta_distribuciones (id, venta_id, version, plantilla_id, porcentaje_comercial, porcentaje_supervision, porcentaje_desarrollo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, venta.id, 1, plantillaId || null, porcentajeComercial, porcentajeSupervision, porcentajeDesarrollo, roleIdentity.email]
    );
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_distribucion', entidadId: id, estadoAnterior: null, estadoNuevo: 'pools_definidos',
      usuarioEmail: roleIdentity.email, motivoNota: `comercial=${porcentajeComercial}% supervision=${porcentajeSupervision}% desarrollo=${porcentajeDesarrollo}%`,
    });
    return ok({ id }, requestId, 201);
  }

  if (body?.action === 'agregar-participacion') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente || vigente.estado !== 'borrador') {
      return Errors.validation('Definí primero los pools de la distribución (definir-pools) antes de agregar participaciones.', requestId);
    }
    const { concepto, beneficiarioEmail, porcentaje, faseId } = body;
    if (!['comercial', 'supervision', 'desarrollo'].includes(concepto)) {
      return Errors.validation('concepto inválido. Valores permitidos: comercial, supervision, desarrollo.', requestId);
    }
    if (!Number.isInteger(porcentaje) || porcentaje <= 0 || porcentaje > 100) {
      return Errors.validation('porcentaje debe ser un entero entre 1 y 100.', requestId);
    }
    if (faseId) {
      const faseRows = await query(
        env.DB, requestId,
        `SELECT c.id FROM componentes c JOIN proyectos p ON p.id = c.proyecto_id WHERE c.id = ? AND p.venta_id = ?`,
        [faseId, venta.id]
      );
      if (!faseRows[0]) return Errors.validation('faseId no corresponde a una fase de este proyecto.', requestId);
    }

    const poolPorConcepto = { comercial: vigente.porcentaje_comercial, supervision: vigente.porcentaje_supervision, desarrollo: vigente.porcentaje_desarrollo };
    const existentes = await query(env.DB, requestId, 'SELECT porcentaje FROM venta_participaciones WHERE distribucion_id = ? AND concepto = ?', [vigente.id, concepto]);
    const asignado = existentes.reduce((s, r) => s + r.porcentaje, 0);
    if (asignado + porcentaje > poolPorConcepto[concepto]) {
      return Errors.validation(
        `"${concepto}" ya tiene ${asignado}% asignado — agregar ${porcentaje}% más superaría el ${poolPorConcepto[concepto]}% reservado. No se crea un pool adicional por fase/componente.`,
        requestId
      );
    }

    const id = crypto.randomUUID();
    await execute(
      env.DB, requestId,
      'INSERT INTO venta_participaciones (id, distribucion_id, concepto, fase_id, beneficiario_email, porcentaje, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, vigente.id, concepto, faseId || null, (beneficiarioEmail && beneficiarioEmail.trim().toLowerCase()) || null, porcentaje, body.note || null, roleIdentity.email]
    );
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_participacion', entidadId: id, estadoAnterior: null, estadoNuevo: 'agregada',
      usuarioEmail: roleIdentity.email,
      motivoNota: `${concepto} ${porcentaje}% — ${beneficiarioEmail ? beneficiarioEmail.trim().toLowerCase() : 'Pendiente de asignación'}${faseId ? ` (fase ${faseId})` : ''}.`,
    });
    return ok({ id }, requestId, 201);
  }

  if (body?.action === 'quitar-participacion') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente || vigente.estado !== 'borrador') {
      return Errors.validation('Solo se pueden quitar participaciones de una distribución en borrador.', requestId);
    }
    if (!body.id) return Errors.validation('Falta id de la participación.', requestId);
    const filaRows = await query(env.DB, requestId, 'SELECT id FROM venta_participaciones WHERE id = ? AND distribucion_id = ?', [body.id, vigente.id]);
    if (!filaRows[0]) return Errors.notFound(requestId);

    await execute(env.DB, requestId, 'DELETE FROM venta_participaciones WHERE id = ?', [body.id]);
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_participacion', entidadId: body.id, estadoAnterior: 'borrador', estadoNuevo: 'quitada',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || null,
    });
    return ok({ id: body.id }, requestId);
  }

  if (body?.action === 'activar') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente || vigente.estado !== 'borrador') {
      return Errors.validation('No hay una distribución en borrador para activar.', requestId);
    }
    const participacionRows = await query(env.DB, requestId, 'SELECT * FROM venta_participaciones WHERE distribucion_id = ?', [vigente.id]);
    const participaciones = participacionRows.map((p) => ({ concepto: p.concepto, beneficiarioEmail: p.beneficiario_email, porcentaje: p.porcentaje, faseId: p.fase_id }));
    const pools = { comercial: vigente.porcentaje_comercial, supervision: vigente.porcentaje_supervision, desarrollo: vigente.porcentaje_desarrollo };
    const resultado = validarActivacionProyecto(pools, participaciones);
    if (!resultado.puedeActivarse) {
      return Errors.conflict('DISTRIBUCION_INCOMPLETA', 'La distribución todavía no cierra en 100% — no se puede activar.', requestId, resultado);
    }

    // RIO-119 (cuarto bloque, 03/09/2026): comisiones y finanzas de
    // empresa se generan ANTES de marcar la distribución 'confirmada' —
    // si algo falla acá, la distribución queda en 'borrador' y un reintento
    // de 'activar' vuelve a intentar todo desde cero (nunca queda
    // "confirmada" sin sus comisiones). generarComisionesDesdeDistribucion
    // ya es idempotente por sí sola (no duplica si distribucion_id ya
    // tiene filas), así que esto es seguro incluso si un reintento
    // llegara a correr dos veces.
    const comisionIds = await generarComisionesDesdeDistribucion(env.DB, requestId, { ventaId: venta.id, distribucionId: vigente.id, actorEmail: roleIdentity.email });
    await registrarFinanzasEmpresa(env.DB, requestId, { ventaId: venta.id, distribucionId: vigente.id, empresaPorcentaje: resultado.empresaPorcentaje, actorEmail: roleIdentity.email });

    const snapshot = JSON.stringify({ pools, empresaPorcentaje: resultado.empresaPorcentaje, participaciones: participacionRows.map(serializeParticipacion), confirmedAt: new Date().toISOString() });
    await execute(env.DB, requestId, "UPDATE venta_distribuciones SET estado = 'confirmada', confirmed_at = datetime('now'), confirmed_by = ? WHERE id = ?", [roleIdentity.email, vigente.id]);
    await execute(env.DB, requestId, 'UPDATE ventas SET distribucion_snapshot = ? WHERE id = ?', [snapshot, venta.id]);
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_distribucion', entidadId: vigente.id, estadoAnterior: 'borrador', estadoNuevo: 'confirmada',
      usuarioEmail: roleIdentity.email, motivoNota: 'Distribución activada — snapshot inmutable guardado, comisiones y finanzas de empresa generadas.',
    });

    return ok({ id: vigente.id, distribucionSnapshot: JSON.parse(snapshot), comisionesGeneradas: comisionIds.length }, requestId);
  }

  if (body?.action === 'corregir') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente || vigente.estado !== 'confirmada') {
      return Errors.validation('Solo se puede corregir una distribución ya confirmada.', requestId);
    }
    if (typeof body.motivo !== 'string' || !body.motivo.trim()) {
      return Errors.validation('La corrección administrativa requiere un motivo.', requestId);
    }

    const participacionRows = await query(env.DB, requestId, 'SELECT * FROM venta_participaciones WHERE distribucion_id = ?', [vigente.id]);
    const nuevaId = crypto.randomUUID();
    const statements = [
      env.DB.prepare("UPDATE venta_distribuciones SET estado = 'reemplazada' WHERE id = ?").bind(vigente.id),
      env.DB.prepare(
        `INSERT INTO venta_distribuciones (id, venta_id, version, plantilla_id, porcentaje_comercial, porcentaje_supervision, porcentaje_desarrollo, motivo_correccion, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(nuevaId, venta.id, vigente.version + 1, vigente.plantilla_id, vigente.porcentaje_comercial, vigente.porcentaje_supervision, vigente.porcentaje_desarrollo, body.motivo.trim(), roleIdentity.email),
      ...participacionRows.map((p) =>
        env.DB.prepare('INSERT INTO venta_participaciones (id, distribucion_id, concepto, fase_id, beneficiario_email, porcentaje, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), nuevaId, p.concepto, p.fase_id, p.beneficiario_email, p.porcentaje, p.note, roleIdentity.email)
      ),
    ];
    try {
      await transaction(env.DB, requestId, statements);
    } catch (e) {
      return Errors.internal(requestId);
    }
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_distribucion', entidadId: nuevaId, estadoAnterior: 'confirmada', estadoNuevo: 'correccion_iniciada',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo.trim(),
    });
    return ok({ id: nuevaId, version: vigente.version + 1 }, requestId, 201);
  }

  // RIO-119 (cuarto bloque, 03/09/2026): estructura CONFIGURABLE de
  // política de liberación y plazo de resguardo — deliberadamente sin
  // efecto automático todavía sobre evaluateComisionGate (ver el gate
  // agregado en _shared/comisiones.js: toda comisión de proyecto
  // personalizado queda bloqueada hasta que Brenda confirme la regla).
  // Guardar esta configuración no habilita pago por sí sola.
  if (body?.action === 'configurar-liberacion') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente) return Errors.validation('Definí primero los pools de la distribución.', requestId);
    const VALID_POLITICAS = ['pago_total', 'proporcional_por_pago', 'por_hito'];
    if (body.politicaLiberacion !== undefined && body.politicaLiberacion !== null && !VALID_POLITICAS.includes(body.politicaLiberacion)) {
      return Errors.validation(`politicaLiberacion inválida. Valores permitidos: ${VALID_POLITICAS.join(', ')}.`, requestId);
    }
    await execute(
      env.DB, requestId,
      'UPDATE venta_distribuciones SET politica_liberacion = ?, requiere_hito_validado = ? WHERE id = ?',
      [body.politicaLiberacion || null, body.requiereHitoValidado ? 1 : 0, vigente.id]
    );
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_distribucion', entidadId: vigente.id, estadoAnterior: null, estadoNuevo: 'politica_liberacion_configurada',
      usuarioEmail: roleIdentity.email, motivoNota: `politicaLiberacion=${body.politicaLiberacion || 'sin definir'} requiereHitoValidado=${!!body.requiereHitoValidado}. No habilita pago automático.`,
    });
    return ok({ id: vigente.id }, requestId);
  }

  if (body?.action === 'configurar-plazo-resguardo') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente) return Errors.validation('Definí primero los pools de la distribución.', requestId);
    const { activo, dias, tipoDias, eventoInicio, alcance } = body;
    const VALID_TIPOS_DIAS = ['habiles', 'corridos'];
    const VALID_EVENTOS = ['activacion', 'primer_pago', 'pago_total', 'hito_aprobado'];
    const VALID_ALCANCES = ['proyecto_completo', 'por_pago_o_hito'];
    if (activo) {
      if (!Number.isInteger(dias) || dias < 0) return Errors.validation('dias debe ser un entero mayor o igual a 0.', requestId);
      if (!VALID_TIPOS_DIAS.includes(tipoDias)) return Errors.validation(`tipoDias inválido. Valores permitidos: ${VALID_TIPOS_DIAS.join(', ')}.`, requestId);
      if (!VALID_EVENTOS.includes(eventoInicio)) return Errors.validation(`eventoInicio inválido. Valores permitidos: ${VALID_EVENTOS.join(', ')}.`, requestId);
      if (!VALID_ALCANCES.includes(alcance)) return Errors.validation(`alcance inválido. Valores permitidos: ${VALID_ALCANCES.join(', ')}.`, requestId);
    }
    await execute(
      env.DB, requestId,
      'UPDATE venta_distribuciones SET plazo_resguardo_activo = ?, plazo_resguardo_dias = ?, plazo_resguardo_tipo_dias = ?, plazo_resguardo_evento_inicio = ?, plazo_resguardo_alcance = ? WHERE id = ?',
      [activo ? 1 : 0, activo ? dias : null, activo ? tipoDias : null, activo ? eventoInicio : null, activo ? alcance : null, vigente.id]
    );
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_distribucion', entidadId: vigente.id, estadoAnterior: null, estadoNuevo: 'plazo_resguardo_configurado',
      usuarioEmail: roleIdentity.email, motivoNota: activo ? `${dias} días ${tipoDias}, desde ${eventoInicio}, alcance ${alcance}. Todavía no habilita pago automático.` : 'Desactivado.',
    });
    return ok({ id: vigente.id }, requestId);
  }

  // Declaración administrativa de que los costos directos del proyecto ya
  // están completos — no hay una lista fija de costos esperados por
  // proyecto a medida, así que "cerrado" es una decisión de
  // Administración, nunca inferida automáticamente.
  if (body?.action === 'cerrar-costos') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente) return Errors.validation('Definí primero los pools de la distribución.', requestId);
    if (vigente.costos_cerrados) return Errors.validation('Los costos de este proyecto ya están cerrados.', requestId);
    await execute(env.DB, requestId, "UPDATE venta_distribuciones SET costos_cerrados = 1, costos_cerrados_por = ?, costos_cerrados_at = datetime('now') WHERE id = ?", [roleIdentity.email, vigente.id]);
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_distribucion', entidadId: vigente.id, estadoAnterior: 'costos_abiertos', estadoNuevo: 'costos_cerrados',
      usuarioEmail: roleIdentity.email, motivoNota: body.motivo || 'Administración declaró los costos directos completos.',
    });
    return ok({ id: vigente.id }, requestId);
  }

  // Recalcula finanzas de empresa (y, si la distribución está confirmada,
  // deja los montos de las comisiones existentes tal como están — el
  // porcentaje histórico NUNCA se recalcula, solo importes futuros que se
  // generen de cero reflejarían un costo nuevo). Requiere motivo cuando ya
  // existe un cálculo previo — es una corrección auditada, no un
  // reemplazo silencioso.
  if (body?.action === 'recalcular-finanzas-empresa') {
    const vigente = await distribucionVigente(env.DB, requestId, venta.id);
    if (!vigente || vigente.estado !== 'confirmada') {
      return Errors.validation('Solo se puede recalcular finanzas de empresa de una distribución ya confirmada.', requestId);
    }
    const yaExiste = await query(env.DB, requestId, 'SELECT id FROM proyecto_finanzas_empresa WHERE distribucion_id = ?', [vigente.id]);
    if (yaExiste.length > 0 && (typeof body.motivo !== 'string' || !body.motivo.trim())) {
      return Errors.validation('Recalcular finanzas ya calculadas requiere un motivo (corrección auditada).', requestId);
    }
    const empresaPorcentaje = Math.max(100 - vigente.porcentaje_comercial - vigente.porcentaje_supervision - vigente.porcentaje_desarrollo, 0);
    const id = await registrarFinanzasEmpresa(env.DB, requestId, { ventaId: venta.id, distribucionId: vigente.id, empresaPorcentaje, actorEmail: roleIdentity.email, motivo: body.motivo || undefined });
    return ok({ id }, requestId, 201);
  }

  return Errors.validation('action inválida. Valores permitidos: definir-pools, agregar-participacion, quitar-participacion, activar, corregir, configurar-liberacion, configurar-plazo-resguardo, cerrar-costos, recalcular-finanzas-empresa.', requestId);
}
