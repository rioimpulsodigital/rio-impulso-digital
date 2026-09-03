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
import { validarActivacionProyecto } from '../../../../../_shared/comisiones.js';

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
    if (!distribucion) return ok({ distribucion: null, participaciones: [], resumen: null }, requestId);
    const participacionRows = await query(env.DB, requestId, 'SELECT * FROM venta_participaciones WHERE distribucion_id = ? ORDER BY concepto ASC, created_at ASC', [distribucion.id]);
    const resumen = validarActivacionProyecto(
      { comercial: distribucion.porcentaje_comercial, supervision: distribucion.porcentaje_supervision, desarrollo: distribucion.porcentaje_desarrollo },
      participacionRows.map((p) => ({ concepto: p.concepto, beneficiarioEmail: p.beneficiario_email, porcentaje: p.porcentaje, faseId: p.fase_id }))
    );
    return ok({
      distribucion: serializeDistribucion(distribucion),
      participaciones: participacionRows.map(serializeParticipacion),
      resumen,
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

    const snapshot = JSON.stringify({ pools, empresaPorcentaje: resultado.empresaPorcentaje, participaciones: participacionRows.map(serializeParticipacion), confirmedAt: new Date().toISOString() });
    await execute(env.DB, requestId, "UPDATE venta_distribuciones SET estado = 'confirmada', confirmed_at = datetime('now'), confirmed_by = ? WHERE id = ?", [roleIdentity.email, vigente.id]);
    await execute(env.DB, requestId, 'UPDATE ventas SET distribucion_snapshot = ? WHERE id = ?', [snapshot, venta.id]);
    await logEvento(env.DB, requestId, {
      ventaId: venta.id, entidad: 'venta_distribucion', entidadId: vigente.id, estadoAnterior: 'borrador', estadoNuevo: 'confirmada',
      usuarioEmail: roleIdentity.email, motivoNota: 'Distribución activada — snapshot inmutable guardado.',
    });
    return ok({ id: vigente.id, distribucionSnapshot: JSON.parse(snapshot) }, requestId);
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

  return Errors.validation('action inválida. Valores permitidos: definir-pools, agregar-participacion, quitar-participacion, activar, corregir.', requestId);
}
