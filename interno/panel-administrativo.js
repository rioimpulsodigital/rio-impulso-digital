/*
 * Panel Administrativo — RIO-119, primer bloque (02/09/2026).
 *
 * Exclusivo de administración: cada acción de este archivo vuelve a
 * autorizarse en el servidor con su propio permiso específico
 * (manageProduccionOficial / verifyPayments) — ocultar un botón acá es
 * solo una comodidad de interfaz, nunca el control real (ver los propios
 * endpoints en functions/interno/api/ventas/[id]/**). No se reimplementa
 * ninguna regla de negocio: cada acción llama exactamente a la misma API
 * que ya usa el resto del sistema (RIO-112 a RIO-118) — este panel es la
 * primera interfaz que las expone, ninguna es nueva.
 *
 * Deliberadamente FUERA de este primer bloque (ver RIO-119 en Notion):
 * administración de personas/equipos/planes de comisión — no existe
 * todavía ningún endpoint de escritura para eso (auditado antes de
 * empezar), queda para un bloque posterior de la misma tarea.
 */

(function () {
  'use strict';

  var identity = null;
  var todasVentas = [];
  var notificaciones = [];
  var notifYaCargadas = false;

  var PRODUCTO_LABEL = {
    ficha: 'Ficha de Google',
    generico: 'Landing genérica',
    personalizado: 'Landing personalizada',
    ficha_generico: 'Pack (Ficha + Landing genérica)',
    ficha_personalizado: 'Pack (Ficha + Landing personalizada)',
  };
  var COMPONENTE_ESTADO_LABEL = {
    bloqueada: 'Bloqueada', pendiente: 'Pendiente', en_produccion: 'En producción',
    entregada: 'Entregada', aprobada: 'Aprobada',
  };
  var PAGO_ESTADO_LABEL = { pendiente: 'Pendiente', informado: 'Informado', acreditado: 'Acreditado' };
  var MATERIALES_ESTADO_LABEL = { pendiente: 'Pendiente', informados: 'Informados (sin confirmar)', completos: 'Completos' };
  var MATERIALES_ESTADO_BADGE = { pendiente: 'neutral', informados: 'amber', completos: 'green' };
  var ESTADO_OPERATIVO_LABEL = {
    en_espera_pago: 'En espera de pago', registrado: 'Registrado',
    en_produccion: 'En producción', completado: 'Completado', cancelada: 'Cancelada',
  };
  var ESTADO_OPERATIVO_BADGE = {
    en_espera_pago: 'amber', registrado: 'neutral',
    en_produccion: 'blue', completado: 'green', cancelada: 'red',
  };
  var ESTADO_REVISION_LABEL = {
    informada: 'Informada', en_revision: 'En revisión', aceptada: 'Aceptada',
    requiere_material_adicional: 'Requiere material adicional', descartada_con_motivo: 'Descartada',
  };
  var ESTADO_REVISION_BADGE = {
    informada: 'neutral', en_revision: 'blue', aceptada: 'green',
    requiere_material_adicional: 'amber', descartada_con_motivo: 'red',
  };
  var GATE_FALTANTE_LABEL = {
    ficha_aprobada: 'La Ficha todavía no fue aprobada.',
    segundo_pago_acreditado: 'El saldo (segundo pago) todavía no está acreditado.',
    materiales_landing_completos: 'Los materiales de la Landing todavía no están completos.',
  };
  var NOTIF_TIPO_LABEL = {
    pago_informado: 'Pago informado',
    materiales_informados: 'Materiales informados',
    material_adicional_informado: 'Material adicional (tras "completos")',
  };

  function fmtMoneda(monto, moneda) {
    if (monto === null || monto === undefined) return '—';
    var simbolo = moneda === 'ARS' ? 'AR$' : 'CLP$';
    return simbolo + ' ' + Number(monto).toLocaleString('es-CL');
  }
  function fmtFecha(iso) {
    if (!iso) return '—';
    var d = new Date(iso.replace(' ', 'T') + (iso.indexOf('T') === -1 && iso.length <= 10 ? '' : 'Z'));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-CL', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nombreParaMostrar(nombre) {
    return nombre || 'Usuario sin nombre configurado';
  }

  async function apiFetch(path, options) {
    var response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
    var body = null;
    try { body = await response.json(); } catch (e) { /* respuestas de archivo no son JSON — no aplica acá */ }
    return { ok: response.ok, status: response.status, body: body };
  }
  function apiPost(path, payload) {
    return apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  }

  // ── Identidad y arranque ──────────────────────────────────────────

  async function whoami() {
    var r = await apiFetch('/interno/api/identidad/whoami');
    if (!r.ok || !r.body || !r.body.ok) return null;
    return r.body.data;
  }

  document.addEventListener('DOMContentLoaded', async function () {
    identity = await whoami();
    // RIO-119: el panel administrativo es exclusivo de administración —
    // mismo criterio que ya usa el detalle de venta (ventas/[id].js
    // "esAdmin = roleIdentity.role === 'admin'") para las facultades que
    // hoy solo tiene ese rol (viewOthersData/manageProduccionOficial/
    // verifyPayments/manageUsers todas true únicamente para admin). Ocultar
    // este panel es una comodidad de interfaz — cada acción individual
    // vuelve a autorizarse en el servidor con su propio permiso.
    if (!identity || identity.role !== 'admin') {
      document.getElementById('pvBlocked').style.display = 'block';
      document.getElementById('pvGreeting').textContent = identity ? 'Tu cuenta no tiene capacidad de administración.' : 'No se pudo verificar tu identidad.';
      return;
    }
    document.getElementById('pvGreeting').textContent =
      identity.nombre + ', acá gestionás la operación diaria: pagos, materiales, avances de proyecto y notificaciones pendientes.';
    document.getElementById('pvApp').style.display = 'block';

    wireTabs();
    wireFilters();
    wireDetailPanel();
    wireNuevoProyecto();
    wirePersonasEquipos();
    wirePlanesComision();
    await cargarVentas();
    await cargarNotificacionesResumen();
    await cargarEquiposDisponibles();
  });

  var TABS = ['ventas', 'notif', 'personas', 'planes'];

  function wireTabs() {
    document.getElementById('pvTabVentasBtn').addEventListener('click', function () { activarTab('ventas'); });
    document.getElementById('pvTabNotifBtn').addEventListener('click', function () {
      activarTab('notif');
      cargarNotificaciones();
    });
    document.getElementById('pvTabPersonasBtn').addEventListener('click', function () {
      activarTab('personas');
      if (!personasYaCargadas) cargarPersonas();
      if (!equiposAdminYaCargados) cargarEquiposAdminTab();
    });
    document.getElementById('pvTabPlanesBtn').addEventListener('click', function () {
      activarTab('planes');
      cargarPlanesComision();
    });
    document.getElementById('fNotifPendientes').addEventListener('change', cargarNotificaciones);
    document.getElementById('fEquiposInactivos').addEventListener('change', cargarEquiposAdminTab);
    document.getElementById('fPlanesInactivos').addEventListener('change', cargarPlanesComision);
  }

  function activarTab(nombre) {
    TABS.forEach(function (t) {
      var esta = t === nombre;
      var btnId = 'pvTab' + t.charAt(0).toUpperCase() + t.slice(1) + 'Btn';
      var panelId = 'pvTab' + t.charAt(0).toUpperCase() + t.slice(1);
      var btn = document.getElementById(btnId);
      var panel = document.getElementById(panelId);
      if (btn) { btn.classList.toggle('active', esta); btn.setAttribute('aria-selected', String(esta)); }
      if (panel) panel.classList.toggle('active', esta);
    });
  }

  // ── Ventas y proyectos ──────────────────────────────────────────────

  async function cargarVentas() {
    var r = await apiFetch('/interno/api/ventas');
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvVentasResult').innerHTML = pvErrorHTML('No se pudieron cargar las ventas. Recargá la página.');
      return;
    }
    todasVentas = r.body.data.ventas || [];
    poblarFiltroVendedor();
    poblarFiltroEquipo();
    poblarFiltroSupervisor();
    renderPipeline();
    renderVentas();
  }

  function poblarFiltroVendedor() {
    var select = document.getElementById('fVendedor');
    var actual = select.value;
    var porEmail = {};
    todasVentas.forEach(function (v) { porEmail[v.vendedorEmail] = v.vendedorNombre; });
    var emails = Object.keys(porEmail).sort(function (a, b) {
      return nombreParaMostrar(porEmail[a]).localeCompare(nombreParaMostrar(porEmail[b]));
    });
    select.innerHTML = '<option value="">Todos</option>' + emails.map(function (e) {
      return '<option value="' + escapeHtml(e) + '">' + escapeHtml(nombreParaMostrar(porEmail[e])) + '</option>';
    }).join('');
    select.value = actual;
  }

  // "Sin equipo asignado" (vacío estructural histórico) y "Venta directa"
  // (elección deliberada de administración, RIO-118) son dos filtros
  // sintéticos distintos — nunca se confunden entre sí ni con un equipo real.
  function poblarFiltroEquipo() {
    var select = document.getElementById('fEquipo');
    var actual = select.value;
    var vistos = {};
    var haySinEquipo = false, hayDirecta = false;
    todasVentas.forEach(function (v) {
      if (v.tipoVenta === 'directa_administracion_sin_supervision') { hayDirecta = true; return; }
      if (!v.equipoId) { haySinEquipo = true; return; }
      vistos[v.equipoId] = v.equipoNombre || v.equipoId;
    });
    var opciones = ['<option value="">Todos</option>'];
    if (haySinEquipo) opciones.push('<option value="__sin_equipo__">Equipo no asignado</option>');
    if (hayDirecta) opciones.push('<option value="__directa__">Venta directa (sin equipo)</option>');
    Object.keys(vistos).sort(function (a, b) { return vistos[a].localeCompare(vistos[b]); }).forEach(function (id) {
      opciones.push('<option value="' + escapeHtml(id) + '">' + escapeHtml(vistos[id]) + '</option>');
    });
    select.innerHTML = opciones.join('');
    select.value = actual;
  }

  function poblarFiltroSupervisor() {
    var select = document.getElementById('fSupervisor');
    var actual = select.value;
    var nombres = {};
    todasVentas.forEach(function (v) { if (v.supervisorNombre) nombres[v.supervisorNombre] = true; });
    var opciones = ['<option value="">Todos</option>'].concat(
      Object.keys(nombres).sort().map(function (n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; })
    );
    select.innerHTML = opciones.join('');
    select.value = actual;
  }

  function renderPipeline() {
    var counts = {};
    todasVentas.forEach(function (v) { counts[v.estadoOperativo] = (counts[v.estadoOperativo] || 0) + 1; });
    var orden = ['en_espera_pago', 'registrado', 'en_produccion', 'completado', 'cancelada'];
    document.getElementById('pvPipeline').innerHTML = orden
      .filter(function (e) { return counts[e]; })
      .map(function (e) {
        return '<span class="pv-pipeline-chip">' + escapeHtml(ESTADO_OPERATIVO_LABEL[e]) + ': <strong>' + counts[e] + '</strong></span>';
      }).join('') || '<span class="pv-pipeline-chip">Sin ventas todavía en tus mercados.</span>';
  }

  function wireFilters() {
    ['fCliente', 'fVendedor', 'fEquipo', 'fSupervisor', 'fMercado', 'fProducto', 'fEstado', 'fDesde', 'fHasta'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', renderVentas);
      document.getElementById(id).addEventListener('change', renderVentas);
    });
    document.getElementById('pvClearFilters').addEventListener('click', function () {
      ['fCliente', 'fVendedor', 'fEquipo', 'fSupervisor', 'fMercado', 'fProducto', 'fEstado', 'fDesde', 'fHasta'].forEach(function (id) { document.getElementById(id).value = ''; });
      renderVentas();
    });
  }

  function ventasFiltradas() {
    var cliente = document.getElementById('fCliente').value.trim().toLowerCase();
    var vendedor = document.getElementById('fVendedor').value;
    var equipo = document.getElementById('fEquipo').value;
    var supervisor = document.getElementById('fSupervisor').value;
    var mercado = document.getElementById('fMercado').value;
    var producto = document.getElementById('fProducto').value;
    var estado = document.getElementById('fEstado').value;
    var desde = document.getElementById('fDesde').value;
    var hasta = document.getElementById('fHasta').value;
    return todasVentas.filter(function (v) {
      if (cliente && (!v.cliente || !v.cliente.negocio || v.cliente.negocio.toLowerCase().indexOf(cliente) === -1)) return false;
      if (vendedor && v.vendedorEmail !== vendedor) return false;
      if (equipo === '__sin_equipo__') { if (v.tipoVenta === 'directa_administracion_sin_supervision' || v.equipoId) return false; }
      else if (equipo === '__directa__') { if (v.tipoVenta !== 'directa_administracion_sin_supervision') return false; }
      else if (equipo) { if (v.equipoId !== equipo) return false; }
      if (supervisor && v.supervisorNombre !== supervisor) return false;
      if (mercado && v.mercado !== mercado) return false;
      if (producto && v.producto !== producto) return false;
      if (estado && v.estadoOperativo !== estado) return false;
      var fechaVenta = (v.createdAt || '').slice(0, 10);
      if (desde && fechaVenta < desde) return false;
      if (hasta && fechaVenta > hasta) return false;
      return true;
    });
  }

  function equipoSupervisorCelda(v) {
    if (v.tipoVenta === 'directa_administracion_sin_supervision') return '<span class="pv-badge pv-badge--purple">Venta directa</span>';
    if (!v.equipoId) return '<span class="pv-badge pv-badge--neutral">Equipo no asignado</span>';
    return escapeHtml(v.equipoNombre || '—') + (v.supervisorNombre ? '<br><span class="pv-mono">' + escapeHtml(v.supervisorNombre) + '</span>' : '');
  }

  function renderVentas() {
    var lista = ventasFiltradas();
    var el = document.getElementById('pvVentasResult');
    if (todasVentas.length === 0) {
      el.innerHTML = pvEmptyHTML('🗂️', 'Todavía no hay ventas registradas en tus mercados.');
      return;
    }
    if (lista.length === 0) {
      el.innerHTML = pvEmptyHTML('🔍', 'Ninguna venta coincide con estos filtros.');
      return;
    }
    var rows = lista.map(function (v) {
      return (
        '<tr tabindex="0" data-venta-id="' + escapeHtml(v.id) + '">' +
          '<td><span class="pv-cliente-nombre">' + escapeHtml(v.cliente && v.cliente.negocio || '—') + '</span><br>' +
            '<span class="pv-mono">' + escapeHtml(v.codigoVenta) + '</span></td>' +
          '<td>' + escapeHtml(nombreParaMostrar(v.vendedorNombre)) + '</td>' +
          '<td>' + equipoSupervisorCelda(v) + '</td>' +
          '<td>' + escapeHtml(v.producto === 'proyecto_personalizado' ? (v.nombreProyecto || 'Proyecto personalizado') : (PRODUCTO_LABEL[v.producto] || v.producto)) + '<br><span class="pv-badge pv-badge--neutral">' + escapeHtml(v.mercado) + '</span></td>' +
          '<td>' + fmtMoneda(v.precioPactado, v.moneda) + '</td>' +
          '<td><span class="pv-badge pv-badge--' + (ESTADO_OPERATIVO_BADGE[v.estadoOperativo] || 'neutral') + '">' + escapeHtml(ESTADO_OPERATIVO_LABEL[v.estadoOperativo] || v.estadoOperativo || '—') + '</span></td>' +
          '<td>' + fmtFecha(v.createdAt) + '</td>' +
        '</tr>'
      );
    }).join('');
    el.innerHTML =
      '<div class="pv-table-wrap"><table class="pv-table">' +
        '<thead><tr><th>Cliente</th><th>Vendedor</th><th>Equipo / Supervisor</th><th>Producto</th><th>Precio</th><th>Estado</th><th>Fecha</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>';
    Array.prototype.forEach.call(el.querySelectorAll('tbody tr'), function (tr) {
      tr.addEventListener('click', function () { abrirDetalleVenta(tr.getAttribute('data-venta-id')); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirDetalleVenta(tr.getAttribute('data-venta-id')); } });
    });
  }

  function pvEmptyHTML(icon, texto) {
    return '<div class="pv-empty"><span class="pv-empty-icon">' + icon + '</span>' + escapeHtml(texto) + '</div>';
  }
  function pvErrorHTML(texto) {
    return '<div class="pv-empty" style="border-color:var(--pv-red-bd);background:var(--pv-red-bg);color:var(--pv-red);">' + escapeHtml(texto) + '</div>';
  }

  // ── Detalle de venta (con acciones administrativas) ─────────────────

  var ventaAbiertaId = null;

  function wireDetailPanel() {
    document.getElementById('pvDetailCloseBtn').addEventListener('click', cerrarDetalleVenta);
    document.getElementById('pvDetailOverlay').addEventListener('click', cerrarDetalleVenta);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.getElementById('pvDetail').classList.contains('open')) cerrarDetalleVenta();
    });
  }

  function cerrarDetalleVenta() {
    document.getElementById('pvDetail').classList.remove('open');
    document.getElementById('pvDetail').setAttribute('aria-hidden', 'true');
    document.getElementById('pvDetailOverlay').classList.remove('open');
    ventaAbiertaId = null;
  }

  async function abrirDetalleVenta(ventaId) {
    var overlay = document.getElementById('pvDetailOverlay');
    var panel = document.getElementById('pvDetail');
    overlay.classList.add('open');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.getElementById('pvDetailBody').innerHTML = '<div class="pv-loading">Cargando…</div>';
    ventaAbiertaId = ventaId;
    await recargarDetalle(ventaId);
  }

  // Nunca se cachea: a diferencia de los paneles de solo lectura, acá cada
  // acción cambia el estado real — el detalle siempre se vuelve a pedir
  // fresco al servidor después de cualquier escritura.
  async function recargarDetalle(ventaId) {
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId));
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvDetailBody').innerHTML = pvErrorHTML('No se pudo cargar el detalle de esta venta.');
      return;
    }
    var detalle = r.body.data;
    document.getElementById('pvDetailCodigo').textContent = detalle.venta.codigoVenta;
    document.getElementById('pvDetailNegocio').textContent = detalle.cliente.negocio;
    document.getElementById('pvDetailBody').innerHTML = await renderDetalleVentaHTML(detalle);
    wireDetalleVentaEventos(detalle);
    if (detalle.venta.producto === 'proyecto_personalizado' && !detalle.venta.modoHistorico) {
      await cargarDistribucionDelDetalle(detalle.venta.id);
    }
    if (detalle.venta.modoHistorico) {
      await cargarComisionesHistoricasDelDetalle(detalle.venta.id, detalle.venta.moneda);
    }
  }

  // RIO-119 (cuarto bloque, 03/09/2026): registro de referencia de lo ya
  // pagado ANTES de que el proyecto se incorporara a este sistema — tabla
  // separada de `comisiones`, nunca entra al calendario 10/25 ni genera
  // deuda actual (ver migración 0029 para la auditoría de alternativas).
  async function cargarComisionesHistoricasDelDetalle(ventaId, moneda) {
    var slot = document.getElementById('pvComisionesHistoricasSlot');
    if (!slot) return;
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/comisiones-historicas');
    if (!r.ok || !r.body || !r.body.ok) { slot.innerHTML = pvErrorHTML('No se pudieron cargar las comisiones históricas.'); return; }
    var lista = r.body.data.comisionesHistoricas || [];
    var filasHTML = lista.map(function (c) {
      return (
        '<div class="pv-notif-card">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(TIPO_PLAN_LABEL_DIST[c.concepto] || c.concepto) + ' — ' + escapeHtml(c.beneficiarioEmail) + ' — <strong>' + fmtMoneda(c.importePagado, c.moneda) + '</strong></span>' +
            '<span class="pv-badge pv-badge--neutral">Histórica</span>' +
          '</div>' +
          '<div style="font-size:.78rem;color:var(--muted);">' + escapeHtml(c.fechaExacta || c.fechaAproximada || '—') + ' · Fuente: ' + escapeHtml(c.fuente) + (c.evidencia ? ' · ' + escapeHtml(c.evidencia) : '') + '</div>' +
        '</div>'
      );
    }).join('') || '<p class="pv-materiales-vacio">Todavía no hay comisiones históricas registradas.</p>';

    slot.innerHTML = filasHTML +
      '<form class="pv-accion-form" data-agregar-comision-historica>' +
        '<label>Beneficiario (correo)</label><input type="email" name="beneficiarioEmail" required>' +
        '<label>Concepto</label><select name="concepto"><option value="comercial">Comercial</option><option value="supervision">Supervisión</option><option value="desarrollo">Desarrollo</option><option value="realizacion">Realización</option><option value="produccion">Producción</option></select>' +
        '<label>Importe pagado</label><input type="number" name="importePagado" min="0" step="1" required>' +
        '<label>Fecha exacta (si se conoce)</label><input type="date" name="fechaExacta">' +
        '<label>Fecha aproximada (si no hay fecha exacta)</label><input type="text" name="fechaAproximada" placeholder="ej. 2025-06">' +
        '<label>Evidencia (opcional)</label><input type="text" name="evidencia" placeholder="ej. captura de transferencia, planilla">' +
        '<label>Fuente (obligatorio)</label><input type="text" name="fuente" placeholder="de dónde se obtuvo este dato" required>' +
        '<button type="submit" class="pv-btn pv-btn--primary">Registrar comisión histórica</button>' +
        '<span class="pv-status-msg" data-status></span>' +
      '</form>';

    var form = slot.querySelector('[data-agregar-comision-historica]');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var r2 = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/comisiones-historicas', {
        beneficiarioEmail: fd.get('beneficiarioEmail').trim(),
        concepto: fd.get('concepto'),
        importePagado: parseInt(fd.get('importePagado'), 10),
        moneda: moneda || 'CLP',
        fechaExacta: fd.get('fechaExacta') || undefined,
        fechaAproximada: fd.get('fechaAproximada') ? fd.get('fechaAproximada').trim() : undefined,
        evidencia: fd.get('evidencia') ? fd.get('evidencia').trim() : undefined,
        fuente: fd.get('fuente').trim(),
      });
      if (!r2.ok || !r2.body || !r2.body.ok) { mostrarStatus(form, (r2.body && r2.body.error && r2.body.error.message) || 'No se pudo registrar.', true); return; }
      await cargarComisionesHistoricasDelDetalle(ventaId);
    });
  }

  function calcularFaltantesLanding(detalle) {
    var landing = detalle.componentes.find(function (c) { return c.tipo === 'landing'; });
    if (!landing || landing.estadoActual !== 'bloqueada') return null;
    var ficha = detalle.componentes.find(function (c) { return c.tipo === 'ficha'; });
    var saldo = detalle.pagosEsperados.find(function (p) { return p.tipo === 'saldo'; });
    var faltantes = [];
    if (!ficha || ficha.estadoActual !== 'aprobada') faltantes.push('ficha_aprobada');
    if (!saldo || saldo.estado !== 'acreditado') faltantes.push('segundo_pago_acreditado');
    if (landing.materialesEstado !== 'completos') faltantes.push('materiales_landing_completos');
    return faltantes;
  }

  function renderTipoVentaSupervisionHTML(venta) {
    var filas = '<dt>Vendedor</dt><dd>' + escapeHtml(nombreParaMostrar(venta.vendedorNombre)) + '</dd>';
    if (venta.tipoVenta === 'directa_administracion_sin_supervision') {
      filas += '<dt>Tipo de venta</dt><dd>Venta directa — sin supervisión</dd>';
    } else if (!venta.equipoId) {
      filas += '<dt>Equipo comercial</dt><dd>Equipo no asignado</dd>';
    } else {
      filas += '<dt>Equipo comercial</dt><dd>' + escapeHtml(venta.equipoNombre || '—') + '</dd>';
      filas += '<dt>Supervisor</dt><dd>' + (venta.supervisorNombre ? escapeHtml(venta.supervisorNombre) : 'Sin supervisor vigente al momento de la venta') + '</dd>';
      if (venta.supervisionAplica) {
        filas += '<dt>Plan de supervisión aplicado</dt><dd>' + venta.porcentajeSupervisionAplicado + '%</dd>';
      }
    }
    return filas;
  }

  function renderAntecedentesHTML(detalle) {
    var kit = detalle.venta.antecedentesKit;
    if (!kit) return '';
    var CATEGORIAS = [
      ['diagnosticoComercial', 'Diagnóstico comercial'],
      ['datosLanding', 'Datos de Landing'],
      ['datosFicha', 'Datos de Ficha'],
      ['facturacion', 'Facturación'],
      ['productoCondiciones', 'Producto y condiciones seleccionadas'],
    ];
    var bloques = CATEGORIAS.map(function (par) {
      var key = par[0], titulo = par[1];
      var valor = kit[key];
      if (!valor) return '';
      var filas;
      if (key === 'diagnosticoComercial') {
        filas = '<div class="pv-kv"><dt>Tipo</dt><dd>' + escapeHtml(valor.tipo + ' — ' + valor.tipoNombre) + '</dd>' +
          (valor.notas ? '<dt>Notas</dt><dd>' + escapeHtml(valor.notas) + '</dd>' : '') + '</div>';
      } else {
        var entradas = Object.keys(valor).filter(function (k) { return valor[k]; });
        if (entradas.length === 0) return '';
        filas = '<dl class="pv-kv">' + entradas.map(function (k) { return '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(valor[k]) + '</dd>'; }).join('') + '</dl>';
      }
      return '<div class="pv-antecedente-categoria"><p class="pv-antecedente-categoria-titulo">' + escapeHtml(titulo) + '</p>' + filas + '</div>';
    }).filter(Boolean).join('');
    if (!bloques) return '';
    return (
      '<details class="pv-antecedentes" open><summary>Antecedentes del Kit</summary>' +
        '<div class="pv-antecedentes-body">' + bloques + '</div>' +
      '</details>'
    );
  }

  // Un botón por transición, mostrado solo cuando el estado actual del
  // componente lo hace plausible — el servidor sigue siendo quien decide
  // de verdad (gates de materiales/pago), acá solo evitamos ofrecer un
  // botón que el servidor rechazaría siempre (ej. "aprobar" sobre algo
  // "pendiente").
  function accionesComponenteHTML(c) {
    var botones = [];
    if (c.estadoActual === 'pendiente') {
      botones.push('<button type="button" class="pv-btn" data-accion-componente="iniciar-produccion" data-componente-id="' + escapeHtml(c.id) + '">Iniciar producción</button>');
    } else if (c.estadoActual === 'en_produccion') {
      botones.push('<button type="button" class="pv-btn" data-accion-componente="entregar" data-componente-id="' + escapeHtml(c.id) + '">Marcar entregada</button>');
    } else if (c.estadoActual === 'entregada') {
      botones.push('<button type="button" class="pv-btn pv-btn--primary" data-accion-componente="aprobar" data-componente-id="' + escapeHtml(c.id) + '">Aprobar</button>');
    }
    // RIO-119: una fase de un proyecto personalizado no tiene el concepto
    // de "materiales que entrega el cliente" — nunca se le ofrece este
    // botón (mismo criterio que el gate que se omite en proyectos.js).
    if (c.tipo !== 'personalizado' && c.materialesEstado !== 'completos') {
      botones.push('<button type="button" class="pv-btn" data-accion-componente="materiales-completos" data-componente-id="' + escapeHtml(c.id) + '">Marcar materiales completos</button>');
    }
    return botones.length ? '<div class="pv-btn-row">' + botones.join('') + '</div>' : '';
  }

  function entregaRevisionFormHTML(c, entrega) {
    // Cada entrega se revisa por separado — nunca se confirma el
    // componente completo por revisar una sola entrega (RIO-118).
    return (
      '<form class="pv-accion-form" data-revisar-entrega="' + escapeHtml(entrega.id) + '" data-componente-id="' + escapeHtml(c.id) + '">' +
        '<label>Resultado de esta entrega</label>' +
        '<select name="resultado">' +
          '<option value="en_revision">En revisión</option>' +
          '<option value="aceptada">Aceptada</option>' +
          '<option value="requiere_material_adicional">Requiere material adicional</option>' +
          '<option value="descartada_con_motivo">Descartada</option>' +
        '</select>' +
        '<textarea name="motivo" placeholder="Motivo (obligatorio para \'requiere adicional\' o \'descartada\')"></textarea>' +
        '<button type="submit" class="pv-btn">Guardar revisión</button>' +
        '<span class="pv-status-msg" data-status></span>' +
      '</form>'
    );
  }

  function renderMaterialesHTML(c) {
    var badge = MATERIALES_ESTADO_BADGE[c.materialesEstado] || 'neutral';
    var html = '<div class="pv-materiales-box">' +
      '<div class="pv-materiales-head">' +
        '<span class="pv-materiales-titulo">Materiales</span>' +
        '<span class="pv-badge pv-badge--' + badge + '">' + escapeHtml(MATERIALES_ESTADO_LABEL[c.materialesEstado] || c.materialesEstado) + '</span>' +
      '</div>';
    (c.materialesInformes || []).forEach(function (i) {
      var badgeRevision = ESTADO_REVISION_BADGE[i.estadoRevision] || 'neutral';
      html += '<div class="pv-materiales-informe">' +
        '<div class="pv-materiales-informe-head">' +
          '<strong>Entrega N.º ' + i.numeroEntrega + '</strong>' +
          '<span class="pv-badge pv-badge--' + badgeRevision + '">' + escapeHtml(ESTADO_REVISION_LABEL[i.estadoRevision] || i.estadoRevision || 'informada') + '</span>' +
        '</div>' +
        escapeHtml(i.informadoPorNombre || 'Usuario sin nombre configurado') + ' · ' + fmtFecha(i.createdAt) +
        (i.elementos && i.elementos.length ? ' — ' + i.elementos.map(escapeHtml).join(', ') : '') +
        (i.cantidadArchivosAprox ? ' · ≈' + i.cantidadArchivosAprox + ' archivo(s)' : '') +
        '<br>' + escapeHtml(i.descripcion || '—') +
        (i.observaciones ? '<br><em>"' + escapeHtml(i.observaciones) + '"</em>' : '') +
        (i.motivoRevision ? '<div class="pv-materiales-motivo-admin">Motivo de revisión: ' + escapeHtml(i.motivoRevision) + '</div>' : '') +
        (i.revisadoPorNombre ? '<div class="pv-materiales-motivo-admin">Revisado por ' + escapeHtml(i.revisadoPorNombre) + ' · ' + fmtFecha(i.revisadoEn) + '</div>' : '') +
        entregaRevisionFormHTML(c, { id: i.id }) +
      '</div>';
    });
    if (!c.materialesInformes || c.materialesInformes.length === 0) {
      html += '<p class="pv-materiales-vacio">Todavía no se informó ninguna entrega.</p>';
    }
    if (c.costoDominioPendiente) {
      html += '<div class="pv-dominio-pendiente">El costo del dominio propio todavía no fue confirmado — mientras tanto, la comisión de esta venta queda estimada.</div>';
    }
    html += '</div>';
    return html;
  }

  function costoDirectoFormHTML(c) {
    return (
      '<form class="pv-costo-form" data-costo-directo="' + escapeHtml(c.id) + '">' +
        '<label style="font-family:var(--ff-mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);">Registrar costo directo (ej. dominio propio)</label>' +
        '<div class="pv-costo-form-row">' +
          '<div class="pv-costo-form-field"><label>Tipo</label><input type="text" name="tipo" value="dominio" required></div>' +
          '<div class="pv-costo-form-field"><label>Monto</label><input type="number" name="monto" min="0" step="1" required></div>' +
          '<div class="pv-costo-form-field" style="flex:1;min-width:120px;"><label>Nota</label><input type="text" name="nota" placeholder="Opcional"></div>' +
          '<button type="submit" class="pv-btn">Registrar</button>' +
        '</div>' +
        '<span class="pv-status-msg" data-status></span>' +
      '</form>'
    );
  }

  // RIO-119 (tercer bloque, item 5, 03/09/2026): metadata de gestión de
  // una fase — orden/responsable operativo/fechas, deliberadamente
  // separado de quién cobra un % (eso vive en la distribución económica,
  // más abajo).
  function faseGestionHTML(c) {
    return (
      '<form class="pv-accion-form" data-editar-fase="' + escapeHtml(c.id) + '" style="border-top:none;padding-top:0;">' +
        '<div class="pv-costo-form-row">' +
          '<div class="pv-costo-form-field" style="max-width:80px;"><label>Orden</label><input type="number" name="orden" min="0" value="' + (c.orden != null ? c.orden : '') + '"></div>' +
          '<div class="pv-costo-form-field"><label>Responsable operativo</label><input type="email" name="responsableOperativoEmail" value="' + escapeHtml(c.responsableOperativoEmail || '') + '"></div>' +
          '<div class="pv-costo-form-field"><label>Fecha prevista</label><input type="date" name="fechaPrevista" value="' + escapeHtml(c.fechaPrevista || '') + '"></div>' +
          '<div class="pv-costo-form-field"><label>Fecha real</label><input type="date" name="fechaReal" value="' + escapeHtml(c.fechaReal || '') + '"></div>' +
          '<button type="submit" class="pv-btn">Guardar</button>' +
        '</div>' +
        '<span class="pv-status-msg" data-status></span>' +
      '</form>'
    );
  }

  var TIPO_PLAN_LABEL_DIST = { comercial: 'Comercial', supervision: 'Supervisión', desarrollo: 'Desarrollo' };

  function finanzasEmpresaHTML(f) {
    if (!f) return '';
    return (
      '<div class="pv-notif-card" style="margin-bottom:12px;">' +
        '<strong>Finanzas de empresa' + (f.esEstimacion ? ' — <span class="pv-badge pv-badge--amber">Estimación</span>' : ' — <span class="pv-badge pv-badge--green">Definitivo</span>') + '</strong>' +
        '<dl class="pv-kv">' +
          '<dt>Monto bruto</dt><dd>' + fmtMoneda(f.montoBruto, f.moneda) + '</dd>' +
          '<dt>Costos directos</dt><dd>' + fmtMoneda(f.costosDirectos, f.moneda) + '</dd>' +
          '<dt>Utilidad neta</dt><dd>' + fmtMoneda(f.utilidadNeta, f.moneda) + '</dd>' +
          '<dt>% empresa</dt><dd>' + f.porcentajeEmpresa + '%</dd>' +
          '<dt>Monto empresa</dt><dd>' + fmtMoneda(f.montoEmpresa, f.moneda) + '</dd>' +
          '<dt>Fondos obtenidos</dt><dd>' + fmtMoneda(f.fondosObtenidos, f.moneda) + '</dd>' +
          '<dt>Fondos todavía estimados</dt><dd>' + fmtMoneda(f.fondosEstimadosPendientes, f.moneda) + '</dd>' +
        '</dl>' +
      '</div>'
    );
  }

  var LIBERACION_MOTIVO_LABEL = {
    cuota_acreditada: 'cuota sin acreditar', plazo_resguardo_10_dias: '10 días corridos sin cumplir',
    hito_validado: 'hito sin validar', sin_incidencia_activa: 'hay una incidencia activa', distribucion_confirmada: 'distribución sin confirmar',
  };
  var LIBERACION_ESTADO_BADGE = { retenida: 'amber', habilitada: 'blue', programada: 'green', pagada: 'green' };
  var LIBERACION_ESTADO_LABEL = { retenida: 'Retenida', habilitada: 'Habilitada', programada: 'Programada', pagada: 'Pagada' };

  function comisionesGeneradasHTML(comisiones) {
    if (!comisiones || comisiones.length === 0) return '';
    var filas = comisiones.map(function (c) {
      var liberacionesHTML = (c.liberaciones || []).map(function (l) {
        var motivos = (l.motivoRetencion || []).map(function (m) { return LIBERACION_MOTIVO_LABEL[m] || m; }).join(', ');
        return (
          '<div style="font-size:.74rem;color:var(--muted);padding:3px 0;">' +
            escapeHtml(l.pagoEtiqueta || l.pagoId) + ': ' + fmtMoneda(l.montoLiberable, l.moneda) +
            ' <span class="pv-badge pv-badge--' + (LIBERACION_ESTADO_BADGE[l.estado] || 'neutral') + '">' + (LIBERACION_ESTADO_LABEL[l.estado] || l.estado) + '</span>' +
            (motivos ? ' — falta: ' + escapeHtml(motivos) : '') +
          '</div>'
        );
      }).join('');
      return (
        '<div class="pv-notif-card">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(TIPO_PLAN_LABEL_DIST[c.tipo] || c.tipo) + ' — ' + escapeHtml(c.beneficiarioEmail) + ' — <strong>' + fmtMoneda(c.montoComision, c.moneda) + '</strong> (' + c.porcentajeSnapshot + '%)</span>' +
            '<span class="pv-badge pv-badge--' + (c.esEstimacion ? 'amber' : 'green') + '">' + (c.esEstimacion ? 'Estimación' : 'Definitivo') + '</span>' +
          '</div>' +
          liberacionesHTML +
          '<div class="pv-btn-row" style="margin-top:6px;"><button type="button" class="pv-btn" data-toggle-adelantos="' + escapeHtml(c.id) + '">Adelantos</button></div>' +
          '<div id="pvAdelantosSlot-' + escapeHtml(c.id) + '" hidden></div>' +
        '</div>'
      );
    }).join('');
    return '<div class="pv-detail-section"><p class="pv-detail-section-title">Comisiones generadas</p>' + filas + '</div>';
  }

  function adelantosHTML(comisionInfo, adelantos) {
    var filas = adelantos.map(function (a) {
      return (
        '<div style="font-size:.76rem;color:var(--muted);padding:3px 0;border-top:1px solid var(--pv-border, #eee);">' +
          fmtMoneda(a.monto, a.moneda) + (a.autoautorizado ? ' <span class="pv-badge pv-badge--amber">Autoautorizado</span>' : '') +
          ' — ' + escapeHtml(a.motivo) + ' — autorizó ' + escapeHtml(a.autorizadoPor) + ' · ' + fmtFecha(a.createdAt) +
          '<br>saldo ' + fmtMoneda(a.saldoAnterior, a.moneda) + ' → ' + fmtMoneda(a.saldoPosterior, a.moneda) +
        '</div>'
      );
    }).join('') || '<p class="pv-materiales-vacio">Todavía no hay adelantos registrados.</p>';
    return (
      '<dl class="pv-kv" style="margin-top:6px;">' +
        '<dt>Monto original</dt><dd>' + fmtMoneda(comisionInfo.montoOriginal, comisionInfo.moneda) + '</dd>' +
        '<dt>Adelantos acumulados</dt><dd>' + fmtMoneda(comisionInfo.adelantosAcumulados, comisionInfo.moneda) + '</dd>' +
        '<dt>Saldo pendiente</dt><dd>' + fmtMoneda(comisionInfo.saldoPendiente, comisionInfo.moneda) + '</dd>' +
      '</dl>' +
      filas +
      '<form class="pv-accion-form" data-registrar-adelanto="' + escapeHtml(comisionInfo.id) + '" style="border-top:none;">' +
        '<label>Monto</label><input type="number" name="monto" min="1" required>' +
        '<label>Medio de pago (opcional)</label><input type="text" name="medioPago">' +
        '<label>Referencia de comprobante (opcional)</label><input type="text" name="comprobanteReferencia">' +
        '<label>Motivo</label><input type="text" name="motivo" required>' +
        '<button type="submit" class="pv-btn pv-btn--primary">Registrar adelanto</button>' +
        '<span class="pv-status-msg" data-status></span>' +
      '</form>'
    );
  }

  function distribucionHTML(distribucion, participaciones, resumen, comisiones, finanzasEmpresa) {
    if (!distribucion) {
      return (
        '<form class="pv-accion-form" data-definir-pools style="border-top:none;padding-top:0;">' +
          '<p style="font-size:.78rem;color:var(--muted);margin:0 0 8px;">Todavía no se definieron los pools de esta distribución. Elegí una plantilla como punto de partida (editable) o cargá los porcentajes a mano — nunca se aplica sola.</p>' +
          '<label>Plantilla (opcional)</label>' +
          '<select name="plantillaId" data-plantilla-select><option value="">— Sin plantilla, cargar a mano —</option></select>' +
          '<label>Pool comercial %</label><input type="number" name="porcentajeComercial" min="0" max="100">' +
          '<label>Pool supervisión %</label><input type="number" name="porcentajeSupervision" min="0" max="100">' +
          '<label>Pool desarrollo (bolsa única del proyecto) %</label><input type="number" name="porcentajeDesarrollo" min="0" max="100">' +
          '<button type="submit" class="pv-btn pv-btn--primary">Definir pools</button>' +
          '<span class="pv-status-msg" data-status></span>' +
        '</form>'
      );
    }

    var filasHTML = participaciones.map(function (part) {
      return (
        '<div class="pv-notif-card">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(TIPO_PLAN_LABEL_DIST[part.concepto] || part.concepto) + ' — <strong>' + part.porcentaje + '%</strong> — ' +
              (part.beneficiarioEmail ? escapeHtml(part.beneficiarioEmail) : '<em style="color:var(--pv-amber, #b8860b);">Pendiente de asignación</em>') +
              (part.faseId ? ' <span class="pv-badge pv-badge--neutral">fase ' + escapeHtml(part.faseId) + '</span>' : '') + '</span>' +
            (distribucion.estado === 'borrador' ? '<button type="button" class="pv-btn pv-btn--danger" data-quitar-participacion="' + escapeHtml(part.id) + '">Quitar</button>' : '') +
          '</div>' +
        '</div>'
      );
    }).join('') || '<p class="pv-materiales-vacio">Todavía no hay participaciones cargadas.</p>';

    var resumenHTML = resumen ? (
      '<dl class="pv-kv">' +
        ['comercial', 'supervision', 'desarrollo'].map(function (k) {
          return '<dt>' + TIPO_PLAN_LABEL_DIST[k] + '</dt><dd>Pool ' + resumen.resumen[k].pool + '% — asignado ' + resumen.resumen[k].asignado + '% — pendiente ' + resumen.resumen[k].pendiente + '%</dd>';
        }).join('') +
        '<dt>Empresa (remanente, nunca una fila)</dt><dd>' + resumen.empresaPorcentaje + '%</dd>' +
      '</dl>'
    ) : '';

    // Configuración avanzada (política de liberación, plazo de resguardo,
    // cerrar costos) — disponible en CUALQUIER estado de la distribución,
    // no solo en borrador: es metadata sobre CÓMO se va a liberar el pago
    // más adelante, independiente de si ya se activó. Nunca habilita pago
    // automático por sí sola (ver el gate en evaluateComisionGate).
    var configAvanzadaHTML =
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Configuración avanzada (no habilita pago automático)</p>' +
        '<p style="font-size:.72rem;color:var(--muted);margin:0 0 8px;">Estructura preparada para cuando Brenda confirme la política de liberación y el plazo de resguardo — nada de esto habilita el pago de una comisión todavía.</p>' +
        (distribucion.costosCerrados
          ? '<p class="pv-status-msg ok">Costos cerrados por ' + escapeHtml(distribucion.costosCerradosPor || '—') + ' el ' + fmtFecha(distribucion.costosCerradosAt) + '.</p>'
          : '<div class="pv-btn-row"><button type="button" class="pv-btn" data-cerrar-costos>Declarar costos directos completos (cerrar costos)</button></div>') +
        '<form class="pv-accion-form" data-configurar-liberacion style="border-top:none;">' +
          '<label>Política de liberación</label>' +
          '<select name="politicaLiberacion">' +
            '<option value="">Sin definir</option>' +
            '<option value="pago_total"' + (distribucion.politicaLiberacion === 'pago_total' ? ' selected' : '') + '>Pago total del proyecto</option>' +
            '<option value="proporcional_por_pago"' + (distribucion.politicaLiberacion === 'proporcional_por_pago' ? ' selected' : '') + '>Proporcional por cada pago acreditado</option>' +
            '<option value="por_hito"' + (distribucion.politicaLiberacion === 'por_hito' ? ' selected' : '') + '>Por hito aprobado y pago asociado</option>' +
          '</select>' +
          '<label><input type="checkbox" name="requiereHitoValidado"' + (distribucion.requiereHitoValidado ? ' checked' : '') + '> Requiere que el hito relacionado esté validado por Administración</label>' +
          '<button type="submit" class="pv-btn">Guardar política</button>' +
          '<span class="pv-status-msg" data-status></span>' +
        '</form>' +
        '<form class="pv-accion-form" data-configurar-plazo-resguardo>' +
          '<label><input type="checkbox" name="activo"' + (distribucion.plazoResguardo && distribucion.plazoResguardo.activo ? ' checked' : '') + '> Existe plazo de resguardo para este proyecto</label>' +
          '<label>Días</label><input type="number" name="dias" min="0" value="' + ((distribucion.plazoResguardo && distribucion.plazoResguardo.dias) || '') + '">' +
          '<label>Tipo de días</label><select name="tipoDias"><option value="corridos">Corridos</option><option value="habiles">Hábiles</option></select>' +
          '<label>Evento que lo inicia</label><select name="eventoInicio"><option value="activacion">Activación</option><option value="primer_pago">Primer pago</option><option value="pago_total">Pago total</option><option value="hito_aprobado">Hito aprobado</option></select>' +
          '<label>Alcance</label><select name="alcance"><option value="proyecto_completo">Proyecto completo</option><option value="por_pago_o_hito">Por pago o hito</option></select>' +
          '<button type="submit" class="pv-btn">Guardar plazo de resguardo</button>' +
          '<span class="pv-status-msg" data-status></span>' +
        '</form>' +
      '</div>';

    var accionesHTML = '';
    if (distribucion.estado === 'borrador') {
      accionesHTML =
        '<form class="pv-accion-form" data-agregar-participacion style="border-top:none;">' +
          '<label>Concepto</label>' +
          '<select name="concepto"><option value="comercial">Comercial</option><option value="supervision">Supervisión</option><option value="desarrollo">Desarrollo</option></select>' +
          '<label>Beneficiario (correo, opcional — vacío = Pendiente de asignación)</label><input type="email" name="beneficiarioEmail">' +
          '<label>Porcentaje</label><input type="number" name="porcentaje" min="1" max="100" required>' +
          '<label>Fase (opcional, id del componente)</label><input type="text" name="faseId">' +
          '<button type="submit" class="pv-btn">Agregar participación</button>' +
          '<span class="pv-status-msg" data-status></span>' +
        '</form>' +
        configAvanzadaHTML +
        '<div class="pv-btn-row"><button type="button" class="pv-btn pv-btn--primary" data-activar-distribucion>Activar (exige 100% asignado)</button></div>' +
        '<p class="pv-status-msg" data-activar-status></p>';
    } else if (distribucion.estado === 'confirmada') {
      accionesHTML =
        '<p style="font-size:.78rem;color:var(--muted);">Confirmada el ' + fmtFecha(distribucion.confirmedAt) + ' por ' + escapeHtml(distribucion.confirmedBy || '—') + '. Snapshot inmutable — un cambio posterior exige una corrección administrativa auditada.</p>' +
        (comisiones && comisiones.length ? '<p style="font-size:.78rem;color:var(--muted);">' + comisiones.length + ' comisión(es) generada(s) — provisionales, no pueden pagarse hasta que se confirme la política de liberación.</p>' : '') +
        configAvanzadaHTML +
        '<div class="pv-btn-row"><button type="button" class="pv-btn" data-recalcular-finanzas>Recalcular finanzas de empresa</button></div>' +
        '<form class="pv-accion-form" data-corregir-distribucion style="border-top:none;">' +
          '<label>Motivo de la corrección (obligatorio)</label><textarea name="motivo" required></textarea>' +
          '<button type="submit" class="pv-btn pv-btn--danger">Corregir (crea una nueva versión auditada)</button>' +
          '<span class="pv-status-msg" data-status></span>' +
        '</form>';
    }

    return finanzasEmpresaHTML(finanzasEmpresa) +
      '<div class="pv-notif-card" style="margin-bottom:12px;"><strong>Estado: ' + escapeHtml(distribucion.estado) + ' (v' + distribucion.version + ')</strong>' + resumenHTML + '</div>' +
      filasHTML + comisionesGeneradasHTML(comisiones) + accionesHTML;
  }

  async function cargarDistribucionDelDetalle(ventaId) {
    var slot = document.getElementById('pvDistribucionSlot');
    if (!slot) return;
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion');
    if (!r.ok || !r.body || !r.body.ok) { slot.innerHTML = pvErrorHTML('No se pudo cargar la distribución económica.'); return; }
    var data = r.body.data;
    try {
      slot.innerHTML = distribucionHTML(data.distribucion, data.participaciones, data.resumen, data.comisiones, data.finanzasEmpresa);
    } catch (e) {
      slot.innerHTML = pvErrorHTML('No se pudo mostrar la distribución económica.');
      return;
    }

    if (!data.distribucion) {
      var rp = await apiFetch('/interno/api/plantillas-distribucion');
      if (rp.ok && rp.body && rp.body.ok) {
        var select = slot.querySelector('[data-plantilla-select]');
        (rp.body.data.plantillas || []).filter(function (pl) { return pl.estado === 'activo'; }).forEach(function (pl) {
          var opt = document.createElement('option');
          opt.value = pl.id;
          opt.textContent = pl.nombre + ' (' + pl.porcentajeComercial + '/' + pl.porcentajeSupervision + '/' + pl.porcentajeDesarrollo + '/' + pl.porcentajeEmpresa + ')';
          select.appendChild(opt);
        });
      }
    }
    wireDistribucionEventos(ventaId);
  }

  function wireDistribucionEventos(ventaId) {
    var slot = document.getElementById('pvDistribucionSlot');

    var definirForm = slot.querySelector('[data-definir-pools]');
    if (definirForm) {
      definirForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var plantillaId = definirForm.querySelector('[name="plantillaId"]').value || undefined;
        var pc = definirForm.querySelector('[name="porcentajeComercial"]').value;
        var ps = definirForm.querySelector('[name="porcentajeSupervision"]').value;
        var pd = definirForm.querySelector('[name="porcentajeDesarrollo"]').value;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', {
          action: 'definir-pools', plantillaId: plantillaId,
          porcentajeComercial: pc !== '' ? parseInt(pc, 10) : undefined,
          porcentajeSupervision: ps !== '' ? parseInt(ps, 10) : undefined,
          porcentajeDesarrollo: pd !== '' ? parseInt(pd, 10) : undefined,
        });
        if (!r.ok || !r.body || !r.body.ok) { mostrarStatus(definirForm, (r.body && r.body.error && r.body.error.message) || 'No se pudo definir los pools.', true); return; }
        await cargarDistribucionDelDetalle(ventaId);
      });
    }

    var agregarForm = slot.querySelector('[data-agregar-participacion]');
    if (agregarForm) {
      agregarForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', {
          action: 'agregar-participacion',
          concepto: agregarForm.querySelector('[name="concepto"]').value,
          beneficiarioEmail: agregarForm.querySelector('[name="beneficiarioEmail"]').value.trim() || undefined,
          porcentaje: parseInt(agregarForm.querySelector('[name="porcentaje"]').value, 10),
          faseId: agregarForm.querySelector('[name="faseId"]').value.trim() || undefined,
        });
        if (!r.ok || !r.body || !r.body.ok) { mostrarStatus(agregarForm, (r.body && r.body.error && r.body.error.message) || 'No se pudo agregar la participación.', true); return; }
        await cargarDistribucionDelDetalle(ventaId);
      });
    }

    Array.prototype.forEach.call(slot.querySelectorAll('[data-quitar-participacion]'), function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', { action: 'quitar-participacion', id: btn.getAttribute('data-quitar-participacion') });
        if (!r.ok || !r.body || !r.body.ok) { alert((r.body && r.body.error && r.body.error.message) || 'No se pudo quitar.'); btn.disabled = false; return; }
        await cargarDistribucionDelDetalle(ventaId);
      });
    });

    var activarBtn = slot.querySelector('[data-activar-distribucion]');
    if (activarBtn) {
      activarBtn.addEventListener('click', async function () {
        activarBtn.disabled = true;
        var statusEl = slot.querySelector('[data-activar-status]');
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', { action: 'activar' });
        if (!r.ok || !r.body || !r.body.ok) {
          var detalleErr = (r.body && r.body.error && r.body.error.details && r.body.error.details.errores) || [];
          statusEl.textContent = detalleErr.length ? detalleErr.join(' ') : ((r.body && r.body.error && r.body.error.message) || 'No se pudo activar.');
          statusEl.className = 'pv-status-msg err';
          activarBtn.disabled = false;
          return;
        }
        await cargarDistribucionDelDetalle(ventaId);
        await recargarDetalle(ventaId);
      });
    }

    var corregirForm = slot.querySelector('[data-corregir-distribucion]');
    if (corregirForm) {
      corregirForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var motivo = corregirForm.querySelector('[name="motivo"]').value.trim();
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', { action: 'corregir', motivo: motivo });
        if (!r.ok || !r.body || !r.body.ok) { mostrarStatus(corregirForm, (r.body && r.body.error && r.body.error.message) || 'No se pudo corregir.', true); return; }
        await cargarDistribucionDelDetalle(ventaId);
      });
    }

    var cerrarCostosBtn = slot.querySelector('[data-cerrar-costos]');
    if (cerrarCostosBtn) {
      cerrarCostosBtn.addEventListener('click', async function () {
        if (!confirm('¿Confirmás que ya se cargaron todos los costos directos de este proyecto? Los importes calculados pasan de estimación a definitivos.')) return;
        cerrarCostosBtn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', { action: 'cerrar-costos' });
        if (!r.ok || !r.body || !r.body.ok) { alert((r.body && r.body.error && r.body.error.message) || 'No se pudo cerrar los costos.'); cerrarCostosBtn.disabled = false; return; }
        await cargarDistribucionDelDetalle(ventaId);
      });
    }

    var recalcularBtn = slot.querySelector('[data-recalcular-finanzas]');
    if (recalcularBtn) {
      recalcularBtn.addEventListener('click', async function () {
        var motivo = prompt('Motivo del recálculo (obligatorio si ya hay un cálculo previo):');
        if (motivo === null) return;
        recalcularBtn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', { action: 'recalcular-finanzas-empresa', motivo: motivo.trim() || undefined });
        if (!r.ok || !r.body || !r.body.ok) { alert((r.body && r.body.error && r.body.error.message) || 'No se pudo recalcular.'); recalcularBtn.disabled = false; return; }
        await cargarDistribucionDelDetalle(ventaId);
      });
    }

    var liberacionForm = slot.querySelector('[data-configurar-liberacion]');
    if (liberacionForm) {
      liberacionForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', {
          action: 'configurar-liberacion',
          politicaLiberacion: liberacionForm.querySelector('[name="politicaLiberacion"]').value || undefined,
          requiereHitoValidado: liberacionForm.querySelector('[name="requiereHitoValidado"]').checked,
        });
        if (!r.ok || !r.body || !r.body.ok) { mostrarStatus(liberacionForm, (r.body && r.body.error && r.body.error.message) || 'No se pudo guardar.', true); return; }
        mostrarStatus(liberacionForm, 'Guardado — no habilita pago automático.', false);
      });
    }

    var plazoForm = slot.querySelector('[data-configurar-plazo-resguardo]');
    if (plazoForm) {
      plazoForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var activo = plazoForm.querySelector('[name="activo"]').checked;
        var dias = plazoForm.querySelector('[name="dias"]').value;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/distribucion', {
          action: 'configurar-plazo-resguardo', activo: activo,
          dias: dias !== '' ? parseInt(dias, 10) : undefined,
          tipoDias: plazoForm.querySelector('[name="tipoDias"]').value,
          eventoInicio: plazoForm.querySelector('[name="eventoInicio"]').value,
          alcance: plazoForm.querySelector('[name="alcance"]').value,
        });
        if (!r.ok || !r.body || !r.body.ok) { mostrarStatus(plazoForm, (r.body && r.body.error && r.body.error.message) || 'No se pudo guardar.', true); return; }
        mostrarStatus(plazoForm, 'Guardado — no habilita pago automático.', false);
      });
    }

    // Adelantos de comisiones (RIO-119, quinto bloque, 04/09/2026).
    Array.prototype.forEach.call(slot.querySelectorAll('[data-toggle-adelantos]'), function (btn) {
      btn.addEventListener('click', async function () {
        var comisionId = btn.getAttribute('data-toggle-adelantos');
        var panel = document.getElementById('pvAdelantosSlot-' + comisionId);
        if (!panel.hidden) { panel.hidden = true; return; }
        panel.innerHTML = '<div class="pv-loading">Cargando…</div>';
        panel.hidden = false;
        await cargarAdelantosDeComision(ventaId, comisionId);
      });
    });
  }

  async function cargarAdelantosDeComision(ventaId, comisionId) {
    var panel = document.getElementById('pvAdelantosSlot-' + comisionId);
    if (!panel) return;
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/comisiones/' + encodeURIComponent(comisionId) + '/adelantos');
    if (!r.ok || !r.body || !r.body.ok) { panel.innerHTML = pvErrorHTML('No se pudieron cargar los adelantos.'); return; }
    var data = r.body.data;
    panel.innerHTML = adelantosHTML(data.comision, data.adelantos);
    var form = panel.querySelector('[data-registrar-adelanto]');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var r2 = await apiPost('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/comisiones/' + encodeURIComponent(comisionId) + '/adelantos', {
        monto: parseInt(fd.get('monto'), 10),
        moneda: data.comision.moneda,
        medioPago: fd.get('medioPago') ? fd.get('medioPago').trim() : undefined,
        comprobanteReferencia: fd.get('comprobanteReferencia') ? fd.get('comprobanteReferencia').trim() : undefined,
        motivo: fd.get('motivo').trim(),
        idempotencyKey: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('adel-' + Date.now() + '-' + Math.random()),
      });
      if (!r2.ok || !r2.body || !r2.body.ok) { mostrarStatus(form, (r2.body && r2.body.error && r2.body.error.message) || 'No se pudo registrar el adelanto.', true); return; }
      await cargarAdelantosDeComision(ventaId, comisionId);
    });
  }

  function renderDetalleVentaHTML(detalle) {
    var faltantesLanding = calcularFaltantesLanding(detalle);

    var componentesHTML = detalle.componentes.map(function (c) {
      var gateHTML = '';
      if (c.tipo === 'landing' && faltantesLanding && faltantesLanding.length > 0) {
        gateHTML = '<div class="pv-gate-faltantes">Todavía bloqueada — falta:<ul>' +
          faltantesLanding.map(function (f) { return '<li>' + escapeHtml(GATE_FALTANTE_LABEL[f]) + '</li>'; }).join('') +
          '</ul></div>';
      }
      return (
        '<div class="pv-componente-card">' +
          '<div class="pv-componente-head">' +
            '<span class="pv-componente-titulo">' + escapeHtml(c.tipo === 'personalizado' ? (c.nombre || 'Fase') : c.tipo) + '</span>' +
            '<span class="pv-badge pv-badge--blue">' + escapeHtml(COMPONENTE_ESTADO_LABEL[c.estadoActual] || c.estadoActual) + '</span>' +
          '</div>' +
          (c.tipo === 'personalizado' && c.descripcion ? '<div class="pv-componente-meta">' + escapeHtml(c.descripcion) + '</div>' : '') +
          '<div class="pv-componente-meta">Precio atribuido: ' + fmtMoneda(c.precioAtribuido, detalle.venta.moneda) + '</div>' +
          (c.tipo === 'personalizado' ? faseGestionHTML(c) : '') +
          gateHTML +
          accionesComponenteHTML(c) +
          (c.tipo === 'personalizado' ? '' : renderMaterialesHTML(c)) +
          costoDirectoFormHTML(c) +
        '</div>'
      );
    }).join('');

    var pagosHTML = detalle.pagosEsperados.map(function (p) { return renderPagoAdminHTML(detalle.venta.id, p, detalle.venta.moneda, detalle.venta.producto === 'proyecto_personalizado'); }).join('');

    var historialPromise = renderHistorialHTML(detalle.venta.id);
    var antecedentesHTML = renderAntecedentesHTML(detalle);

    return historialPromise.then(function (historialHTML) {
      return (
        '<div class="pv-detail-section"><p class="pv-detail-section-title">Venta</p>' +
          (detalle.venta.modoHistorico
            ? '<div class="pv-notif-card" style="margin-bottom:8px;"><span class="pv-badge pv-badge--neutral">Importación histórica — ' +
                escapeHtml(detalle.venta.modoHistorico === 'referencia' ? 'solo referencia' : 'con reconstrucción económica') +
                '</span> <span style="font-size:.78rem;color:var(--muted);">Sin plazos, sin notificaciones, sin comisiones nuevas, nunca sincronizada con HubSpot.</span></div>'
            : '') +
          '<dl class="pv-kv">' +
            (detalle.venta.producto === 'proyecto_personalizado'
              ? '<dt>Proyecto</dt><dd>' + escapeHtml(detalle.venta.nombreProyecto || '—') + '</dd>' +
                (detalle.venta.descripcionProyecto ? '<dt>Descripción</dt><dd>' + escapeHtml(detalle.venta.descripcionProyecto) + '</dd>' : '') +
                (detalle.venta.notionUrl ? '<dt>Notion</dt><dd><a href="' + escapeHtml(detalle.venta.notionUrl) + '" target="_blank" rel="noopener">Ver página operativa</a></dd>' : '')
              : '<dt>Producto</dt><dd>' + escapeHtml(PRODUCTO_LABEL[detalle.venta.producto] || detalle.venta.producto) + '</dd>') +
            '<dt>Mercado</dt><dd>' + escapeHtml(detalle.venta.mercado) + '</dd>' +
            '<dt>Precio pactado</dt><dd>' + fmtMoneda(detalle.venta.precioPactado, detalle.venta.moneda) + '</dd>' +
            '<dt>Fecha</dt><dd>' + fmtFecha(detalle.venta.createdAt) + '</dd>' +
            (detalle.venta.proximaAccion ? '<dt>Próxima acción</dt><dd>' + escapeHtml(detalle.venta.proximaAccion) + (detalle.venta.responsableProximaAccion ? ' (' + escapeHtml(detalle.venta.responsableProximaAccion) + ')' : '') + '</dd>' : '') +
            renderTipoVentaSupervisionHTML(detalle.venta) +
          '</dl>' +
          costoMedioPagoFormHTML(detalle.venta.id) +
        '</div>' +
        (detalle.venta.producto === 'proyecto_personalizado' && !detalle.venta.modoHistorico
          ? '<div class="pv-detail-section"><p class="pv-detail-section-title">Distribución económica</p><div id="pvDistribucionSlot"><div class="pv-loading">Cargando…</div></div></div>'
          : '') +
        (detalle.venta.modoHistorico
          ? '<div class="pv-detail-section"><p class="pv-detail-section-title">Comisiones históricas (pagadas antes de la incorporación)</p><div id="pvComisionesHistoricasSlot"><div class="pv-loading">Cargando…</div></div></div>'
          : '') +
        '<div class="pv-detail-section"><p class="pv-detail-section-title">Cliente</p>' +
          '<dl class="pv-kv">' +
            '<dt>Negocio</dt><dd>' + escapeHtml(detalle.cliente.negocio) + '</dd>' +
            (detalle.cliente.contactoNombre ? '<dt>Contacto</dt><dd>' + escapeHtml(detalle.cliente.contactoNombre) + '</dd>' : '') +
            (detalle.cliente.telefono ? '<dt>Teléfono</dt><dd>' + escapeHtml(detalle.cliente.telefono) + '</dd>' : '') +
            (detalle.cliente.datosFacturacionAr ? '<dt>Facturación</dt><dd>' + escapeHtml(detalle.cliente.datosFacturacionAr) + '</dd>' : '') +
          '</dl>' +
        '</div>' +
        '<div class="pv-detail-section"><p class="pv-detail-section-title">Proyecto y componentes</p>' + componentesHTML + '</div>' +
        '<div class="pv-detail-section"><p class="pv-detail-section-title">Pagos</p>' + pagosHTML + '</div>' +
        '<div class="pv-detail-section"><p class="pv-detail-section-title">Avance y próximo paso</p>' + historialHTML + '</div>' +
        (antecedentesHTML ? '<div class="pv-detail-section">' + antecedentesHTML + '</div>' : '')
      );
    });
  }

  function costoMedioPagoFormHTML(ventaId) {
    return (
      '<form class="pv-costo-form" data-costo-medio-pago="' + escapeHtml(ventaId) + '">' +
        '<label style="font-family:var(--ff-mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);">Registrar costo del medio de pago (se prorratea si es un pack)</label>' +
        '<div class="pv-costo-form-row">' +
          '<div class="pv-costo-form-field"><label>Tipo</label><input type="text" name="tipo" value="comision_pasarela" required></div>' +
          '<div class="pv-costo-form-field"><label>Monto</label><input type="number" name="monto" min="0" step="1" required></div>' +
          '<div class="pv-costo-form-field" style="flex:1;min-width:120px;"><label>Nota</label><input type="text" name="nota" placeholder="Opcional"></div>' +
          '<button type="submit" class="pv-btn">Registrar</button>' +
        '</div>' +
        '<span class="pv-status-msg" data-status></span>' +
      '</form>'
    );
  }

  function renderPagoAdminHTML(ventaId, pago, moneda, esProyectoPersonalizado) {
    var badgeClass = pago.estado === 'acreditado' ? 'green' : (pago.estado === 'informado' ? 'blue' : 'neutral');
    var hitoHTML = '';
    if (esProyectoPersonalizado) {
      hitoHTML = pago.hitoValidado
        ? '<p class="pv-status-msg ok">Hito validado por ' + escapeHtml(pago.hitoValidadoPor || '—') + ' · ' + fmtFecha(pago.hitoValidadoAt) + (pago.hitoNota ? ' — ' + escapeHtml(pago.hitoNota) : '') + '</p>'
        : '<form class="pv-accion-form" data-validar-hito="' + escapeHtml(pago.id) + '" style="border-top:none;padding-top:0;">' +
            '<label>Validar hito/avance de esta cuota (condición para liberar la comisión)</label>' +
            '<input type="text" name="nota" placeholder="Nota (opcional)">' +
            '<button type="submit" class="pv-btn">Validar hito</button>' +
            '<span class="pv-status-msg" data-status></span>' +
          '</form>';
    }
    var accionesHTML = '';
    if (pago.estado === 'pendiente') {
      accionesHTML = '<p class="pv-componente-meta">Pendiente de que el vendedor lo informe.</p>';
    } else {
      accionesHTML =
        '<div class="pv-comprobante-link" data-comprobante-slot="' + escapeHtml(pago.id) + '">Consultando comprobante…</div>' +
        '<form class="pv-accion-form" data-acreditar-pago="' + escapeHtml(pago.id) + '">' +
          '<label>Acreditar pago</label>' +
          '<input type="number" name="montoAcreditado" min="1" step="1" placeholder="Monto acreditado" required>' +
          '<input type="text" name="nota" placeholder="Nota (opcional)">' +
          '<button type="submit" class="pv-btn pv-btn--primary">Acreditar</button>' +
          '<span class="pv-status-msg" data-status></span>' +
        '</form>';
      if (pago.estado !== 'acreditado') {
        accionesHTML +=
          '<form class="pv-accion-form" data-rechazar-pago="' + escapeHtml(pago.id) + '">' +
            '<label>Rechazar / solicitar un comprobante nuevo</label>' +
            '<textarea name="motivo" placeholder="Motivo (obligatorio)" required></textarea>' +
            '<button type="submit" class="pv-btn pv-btn--danger">Rechazar y pedir comprobante nuevo</button>' +
            '<span class="pv-status-msg" data-status></span>' +
          '</form>';
      }
    }
    return (
      '<div class="pv-pago-card">' +
        '<div class="pv-pago-head">' +
          '<span class="pv-pago-titulo">' + escapeHtml(pago.etiqueta || pago.tipo) + ' — ' + fmtMoneda(pago.monto, moneda) + '</span>' +
          '<span class="pv-badge pv-badge--' + badgeClass + '">' + escapeHtml(PAGO_ESTADO_LABEL[pago.estado] || pago.estado) + '</span>' +
        '</div>' +
        hitoHTML +
        accionesHTML +
      '</div>'
    );
  }

  async function cargarComprobantesDelDetalle(detalle) {
    // El archivo nunca se referencia con una URL pública — el link real
    // pasa por la ruta autenticada .../comprobante/:comprobanteId/archivo,
    // servida solo a través del binding privado de R2 (RIO-116). Consulta
    // aparte porque el metadata no viaja dentro de GET /ventas/:id.
    for (var i = 0; i < detalle.pagosEsperados.length; i++) {
      var pago = detalle.pagosEsperados[i];
      if (pago.estado === 'pendiente') continue;
      var slot = document.querySelector('[data-comprobante-slot="' + pago.id + '"]');
      if (!slot) continue;
      var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/pagos/' + encodeURIComponent(pago.id) + '/comprobante');
      var comprobante = (r.ok && r.body && r.body.ok) ? r.body.data.comprobante : null;
      if (comprobante && comprobante.rechazadoEn) {
        slot.innerHTML = '<strong style="color:var(--pv-red);">Comprobante rechazado.</strong> Motivo: ' + escapeHtml(comprobante.motivoRechazo);
      } else if (comprobante) {
        slot.innerHTML = '<a href="/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/pagos/' + encodeURIComponent(pago.id) + '/comprobante/' + encodeURIComponent(comprobante.id) + '/archivo" target="_blank" rel="noopener">Ver comprobante (versión ' + comprobante.version + ')</a>';
      } else {
        slot.innerHTML = '<em style="color:var(--muted);">Todavía no se subió ningún comprobante.</em>';
      }
    }
  }

  async function renderHistorialHTML(ventaId) {
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/historial');
    if (!r.ok || !r.body || !r.body.ok || !r.body.data.eventos || r.body.data.eventos.length === 0) {
      return '<p style="font-size:.82rem;color:var(--muted);">Todavía no hay eventos registrados.</p>';
    }
    var eventos = r.body.data.eventos;
    var ultimo = eventos[eventos.length - 1];
    var itemsHTML = eventos.slice(-10).reverse().map(function (e) {
      return (
        '<li>' +
          '<div class="pv-timeline-fecha">' + fmtFecha(e.createdAt) + '</div>' +
          '<div class="pv-timeline-desc">' + escapeHtml(e.entidad) + ': ' + escapeHtml(e.estadoNuevo) + (e.motivoNota ? ' — ' + escapeHtml(e.motivoNota) : '') + '</div>' +
        '</li>'
      );
    }).join('');
    var proximaHTML = ultimo.proximaAccion
      ? '<p class="pv-timeline-proxima">Próximo paso: ' + escapeHtml(ultimo.proximaAccion) + (ultimo.responsableProximaAccion ? ' (' + escapeHtml(ultimo.responsableProximaAccion) + ')' : '') + '</p>'
      : '';
    return proximaHTML + '<ul class="pv-timeline">' + itemsHTML + '</ul>';
  }

  // ── Wiring de acciones dentro del detalle ────────────────────────────

  function mostrarStatus(form, texto, esError) {
    var span = form.querySelector('[data-status]');
    if (!span) return;
    span.textContent = texto;
    span.className = 'pv-status-msg ' + (esError ? 'err' : 'ok');
  }

  function wireDetalleVentaEventos(detalle) {
    var body = document.getElementById('pvDetailBody');

    // Cargar comprobantes de forma asíncrona, sin bloquear el render.
    cargarComprobantesDelDetalle(detalle);

    // Transiciones oficiales de componente (iniciar-producción / entregar / aprobar / materiales-completos).
    Array.prototype.forEach.call(body.querySelectorAll('[data-accion-componente]'), function (btn) {
      btn.addEventListener('click', async function () {
        var accion = btn.getAttribute('data-accion-componente');
        var componenteId = btn.getAttribute('data-componente-id');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/componentes/' + encodeURIComponent(componenteId), { action: accion });
        if (!r.ok || !r.body || !r.body.ok) {
          alert((r.body && r.body.error && r.body.error.message) || 'No se pudo completar la acción — puede faltar cumplir una condición.');
          btn.disabled = false;
          return;
        }
        await recargarDetalle(detalle.venta.id);
        await cargarVentas(); // el avance operativo de la tabla puede haber cambiado.
      });
    });

    // Revisión de una entrega puntual de materiales.
    Array.prototype.forEach.call(body.querySelectorAll('[data-revisar-entrega]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var entregaId = form.getAttribute('data-revisar-entrega');
        var componenteId = form.getAttribute('data-componente-id');
        var resultado = form.querySelector('[name="resultado"]').value;
        var motivo = form.querySelector('[name="motivo"]').value.trim();
        if ((resultado === 'requiere_material_adicional' || resultado === 'descartada_con_motivo') && !motivo) {
          mostrarStatus(form, 'Este resultado requiere un motivo.', true);
          return;
        }
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/componentes/' + encodeURIComponent(componenteId), {
          action: 'revisar-entrega-materiales', entregaId: entregaId, resultado: resultado, motivo: motivo || undefined,
        });
        if (!r.ok || !r.body || !r.body.ok) {
          mostrarStatus(form, (r.body && r.body.error && r.body.error.message) || 'No se pudo guardar la revisión.', true);
          btn.disabled = false;
          return;
        }
        await recargarDetalle(detalle.venta.id);
      });
    });

    // Metadata de gestión de una fase (orden/responsable operativo/fechas)
    // — nunca toca estado_actual, eso sigue viajando por las transiciones
    // oficiales de arriba.
    Array.prototype.forEach.call(body.querySelectorAll('[data-editar-fase]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var componenteId = form.getAttribute('data-editar-fase');
        var ordenVal = form.querySelector('[name="orden"]').value;
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/componentes/' + encodeURIComponent(componenteId), {
          action: 'editar-fase',
          orden: ordenVal !== '' ? parseInt(ordenVal, 10) : undefined,
          responsableOperativoEmail: form.querySelector('[name="responsableOperativoEmail"]').value.trim() || null,
          fechaPrevista: form.querySelector('[name="fechaPrevista"]').value || null,
          fechaReal: form.querySelector('[name="fechaReal"]').value || null,
        });
        if (!r.ok || !r.body || !r.body.ok) {
          mostrarStatus(form, (r.body && r.body.error && r.body.error.message) || 'No se pudo guardar.', true);
          btn.disabled = false;
          return;
        }
        mostrarStatus(form, 'Guardado.', false);
        btn.disabled = false;
      });
    });

    // Costo directo por componente (ej. dominio propio).
    Array.prototype.forEach.call(body.querySelectorAll('[data-costo-directo]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var componenteId = form.getAttribute('data-costo-directo');
        var tipo = form.querySelector('[name="tipo"]').value.trim();
        var monto = parseInt(form.querySelector('[name="monto"]').value, 10);
        var nota = form.querySelector('[name="nota"]').value.trim();
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/componentes/' + encodeURIComponent(componenteId) + '/costos', { tipo: tipo, monto: monto, nota: nota || undefined });
        if (!r.ok || !r.body || !r.body.ok) {
          mostrarStatus(form, (r.body && r.body.error && r.body.error.message) || 'No se pudo registrar el costo.', true);
          btn.disabled = false;
          return;
        }
        mostrarStatus(form, 'Costo registrado.', false);
        btn.disabled = false;
        form.reset();
        form.querySelector('[name="tipo"]').value = tipo;
      });
    });

    // Costo del medio de pago (nivel venta, se prorratea si es un pack).
    var costoMedioPagoForm = body.querySelector('[data-costo-medio-pago]');
    if (costoMedioPagoForm) {
      costoMedioPagoForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var tipo = costoMedioPagoForm.querySelector('[name="tipo"]').value.trim();
        var monto = parseInt(costoMedioPagoForm.querySelector('[name="monto"]').value, 10);
        var nota = costoMedioPagoForm.querySelector('[name="nota"]').value.trim();
        var btn = costoMedioPagoForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/costos-medio-pago', { tipo: tipo, monto: monto, nota: nota || undefined });
        if (!r.ok || !r.body || !r.body.ok) {
          mostrarStatus(costoMedioPagoForm, (r.body && r.body.error && r.body.error.message) || 'No se pudo registrar el costo.', true);
          btn.disabled = false;
          return;
        }
        mostrarStatus(costoMedioPagoForm, 'Costo registrado.', false);
        btn.disabled = false;
        costoMedioPagoForm.reset();
        costoMedioPagoForm.querySelector('[name="tipo"]').value = tipo;
      });
    }

    // Validar hito/avance de una cuota (RIO-119, quinto bloque, 04/09/2026)
    // — condición 3 para que una participación de proyecto personalizado
    // pueda liberarse.
    Array.prototype.forEach.call(body.querySelectorAll('[data-validar-hito]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pagoId = form.getAttribute('data-validar-hito');
        var nota = form.querySelector('[name="nota"]').value.trim();
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/pagos/' + encodeURIComponent(pagoId), { action: 'validar-hito', nota: nota || undefined });
        if (!r.ok || !r.body || !r.body.ok) {
          mostrarStatus(form, (r.body && r.body.error && r.body.error.message) || 'No se pudo validar el hito.', true);
          btn.disabled = false;
          return;
        }
        await recargarDetalle(detalle.venta.id);
      });
    });

    // Acreditar pago.
    Array.prototype.forEach.call(body.querySelectorAll('[data-acreditar-pago]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pagoId = form.getAttribute('data-acreditar-pago');
        var monto = parseInt(form.querySelector('[name="montoAcreditado"]').value, 10);
        var nota = form.querySelector('[name="nota"]').value.trim();
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/pagos/' + encodeURIComponent(pagoId), { action: 'acreditar', montoAcreditado: monto, nota: nota || undefined });
        if (!r.ok || !r.body || !r.body.ok) {
          mostrarStatus(form, (r.body && r.body.error && r.body.error.message) || 'No se pudo acreditar el pago.', true);
          btn.disabled = false;
          return;
        }
        await recargarDetalle(detalle.venta.id);
        await cargarVentas();
      });
    });

    // Rechazar pago / solicitar comprobante nuevo (mismo endpoint —
    // "rechazar" revierte el pago a pendiente y marca el comprobante
    // vigente como rechazado, forzando al vendedor a informar y subir de
    // nuevo — no existe una acción separada en el servidor para esto).
    Array.prototype.forEach.call(body.querySelectorAll('[data-rechazar-pago]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pagoId = form.getAttribute('data-rechazar-pago');
        var motivo = form.querySelector('[name="motivo"]').value.trim();
        if (!motivo) { mostrarStatus(form, 'El motivo es obligatorio.', true); return; }
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        var r = await apiPost('/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/pagos/' + encodeURIComponent(pagoId), { action: 'rechazar', motivo: motivo });
        if (!r.ok || !r.body || !r.body.ok) {
          mostrarStatus(form, (r.body && r.body.error && r.body.error.message) || 'No se pudo rechazar el pago.', true);
          btn.disabled = false;
          return;
        }
        await recargarDetalle(detalle.venta.id);
        await cargarVentas();
      });
    });
  }

  // ── Notificaciones pendientes de revisión ────────────────────────────

  async function cargarNotificacionesResumen() {
    // Solo para el badge del tab — no reemplaza la carga completa cuando
    // se abre la pestaña (que sí respeta el filtro de "solo pendientes").
    var r = await apiFetch('/interno/api/notificaciones?pendientes=1');
    if (!r.ok || !r.body || !r.body.ok) return;
    var pendientes = r.body.data.notificaciones || [];
    var badge = document.getElementById('pvNotifBadge');
    if (pendientes.length > 0) {
      badge.textContent = pendientes.length > 99 ? '99+' : String(pendientes.length);
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }

  async function cargarNotificaciones() {
    document.getElementById('pvNotifResult').innerHTML = '<div class="pv-loading">Cargando notificaciones…</div>';
    var soloPendientes = document.getElementById('fNotifPendientes').checked;
    var r = await apiFetch('/interno/api/notificaciones' + (soloPendientes ? '?pendientes=1' : ''));
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvNotifResult').innerHTML = pvErrorHTML('No se pudieron cargar las notificaciones.');
      return;
    }
    notificaciones = r.body.data.notificaciones || [];
    notifYaCargadas = true;
    renderNotificaciones();
  }

  function renderNotificaciones() {
    var el = document.getElementById('pvNotifResult');
    if (notificaciones.length === 0) {
      el.innerHTML = pvEmptyHTML('🔔', 'No hay notificaciones para mostrar.');
      return;
    }
    el.innerHTML = notificaciones.map(function (n) {
      var atendida = !!n.atendidaEn;
      return (
        '<div class="pv-notif-card' + (atendida ? ' leida' : '') + '" data-notif-id="' + escapeHtml(n.id) + '">' +
          '<div class="pv-notif-head">' +
            '<span class="pv-notif-tipo">' + escapeHtml(NOTIF_TIPO_LABEL[n.tipo] || n.tipo) + '</span>' +
            (atendida ? '<span class="pv-badge pv-badge--green">Atendida</span>' : '<span class="pv-badge pv-badge--amber">Pendiente</span>') +
          '</div>' +
          '<div class="pv-notif-meta">' + escapeHtml(n.clienteNegocio || '—') + ' · ' + escapeHtml(n.mercado || '') + ' · ' + fmtFecha(n.createdAt) + '</div>' +
          '<div class="pv-btn-row">' +
            '<button type="button" class="pv-btn" data-ver-venta="' + escapeHtml(n.ventaId) + '">Ver venta</button>' +
            (atendida ? '' : '<button type="button" class="pv-btn" data-atender-notif="' + escapeHtml(n.id) + '">Marcar atendida</button>') +
          '</div>' +
        '</div>'
      );
    }).join('');

    Array.prototype.forEach.call(el.querySelectorAll('[data-ver-venta]'), function (btn) {
      btn.addEventListener('click', function () {
        var ventaId = btn.getAttribute('data-ver-venta');
        activarTab('ventas');
        abrirDetalleVenta(ventaId);
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-atender-notif]'), function (btn) {
      btn.addEventListener('click', async function () {
        var notifId = btn.getAttribute('data-atender-notif');
        btn.disabled = true;
        var r = await apiPost('/interno/api/notificaciones/' + encodeURIComponent(notifId), { action: 'atender' });
        if (!r.ok || !r.body || !r.body.ok) {
          alert((r.body && r.body.error && r.body.error.message) || 'No se pudo marcar como atendida.');
          btn.disabled = false;
          return;
        }
        await cargarNotificaciones();
        await cargarNotificacionesResumen();
      });
    });
  }

  // ── Nuevo proyecto personalizado (ej. Nua Bushi — eCommerce + Laudus,
  // 02/09/2026) ─────────────────────────────────────────────────────────
  // Un proyecto que NO es Ficha/Landing/Pack del catálogo — administración
  // lo registra acá con sus propias fases (componentes libres) y su propio
  // calendario de pagos. El servidor vuelve a validar todo (admin-only,
  // suma de fases = precio, suma de pagos = precio) — este formulario solo
  // evita que se envíe algo que el servidor rechazaría siempre.

  var equiposDisponibles = [];

  async function cargarEquiposDisponibles() {
    try {
      var r = await apiFetch('/interno/api/equipos');
      if (r.ok && r.body && r.body.ok) equiposDisponibles = r.body.data.equipos || [];
    } catch (e) { /* el selector queda solo con "venta directa" — no bloquea el resto del panel */ }
  }

  function poblarTipoVentaProyecto() {
    var select = document.getElementById('npTipoVenta');
    var mercado = document.getElementById('npMercado').value;
    while (select.options.length > 2) select.remove(2);
    equiposDisponibles.filter(function (eq) { return eq.mercado === mercado; }).forEach(function (eq) {
      var opt = document.createElement('option');
      opt.value = 'equipo:' + eq.id;
      opt.textContent = eq.nombre;
      select.appendChild(opt);
    });
  }

  function fasePagoRowHTML(kind, index) {
    if (kind === 'fase') {
      return (
        '<div class="np-row" data-fase-row>' +
          '<div class="np-row-field"><label>Nombre de la fase</label><input type="text" data-fase-nombre required></div>' +
          '<div class="np-row-field"><label>Descripción</label><input type="text" data-fase-descripcion placeholder="Opcional"></div>' +
          '<div class="np-row-field" style="max-width:140px;"><label>Precio atribuido</label><input type="number" min="1" step="1" data-fase-precio required></div>' +
          '<button type="button" class="pv-btn pv-btn--danger np-row-remove" data-quitar-fila>Quitar</button>' +
        '</div>'
      );
    }
    return (
      '<div class="np-row" data-pago-row>' +
        '<div class="np-row-field"><label>Etiqueta del pago</label><input type="text" data-pago-etiqueta required></div>' +
        '<div class="np-row-field" style="max-width:140px;"><label>Monto</label><input type="number" min="1" step="1" data-pago-monto required></div>' +
        '<button type="button" class="pv-btn pv-btn--danger np-row-remove" data-quitar-fila>Quitar</button>' +
      '</div>'
    );
  }

  function participacionRowHTML() {
    return (
      '<div class="np-row" data-participacion-row>' +
        '<div class="np-row-field" style="max-width:160px;"><label>Concepto</label><input type="text" data-part-concepto placeholder="comercial, supervision, desarrollo…" required></div>' +
        '<div class="np-row-field"><label>Beneficiario (correo)</label><input type="email" data-part-email required></div>' +
        '<div class="np-row-field" style="max-width:110px;"><label>Porcentaje</label><input type="number" min="0" max="100" step="1" data-part-porcentaje required></div>' +
        '<button type="button" class="pv-btn pv-btn--danger np-row-remove" data-quitar-fila>Quitar</button>' +
      '</div>'
    );
  }

  function agregarFilaParticipacion() {
    var contenedor = document.getElementById('npDistribucionLista');
    var wrapper = document.createElement('div');
    wrapper.innerHTML = participacionRowHTML();
    var fila = wrapper.firstElementChild;
    contenedor.appendChild(fila);
    fila.querySelector('[data-quitar-fila]').addEventListener('click', function () { fila.remove(); recomputarSumaDistribucion(); });
    fila.querySelector('[data-part-porcentaje]').addEventListener('input', recomputarSumaDistribucion);
    recomputarSumaDistribucion();
  }

  // "Empresa" nunca se modela como fila que administración completa a
  // mano — es siempre el remanente implícito (100 - suma de las
  // participaciones cargadas), calculado acá igual que
  // validarDistribucion() en el servidor (_shared/comisiones.js).
  function recomputarSumaDistribucion() {
    var filas = document.querySelectorAll('[data-participacion-row]');
    var el = document.getElementById('npDistribucionSuma');
    if (filas.length === 0) { el.textContent = ''; el.className = 'pv-status-msg'; return; }
    var suma = 0;
    Array.prototype.forEach.call(filas, function (fila) { suma += parseInt(fila.querySelector('[data-part-porcentaje]').value, 10) || 0; });
    var empresa = Math.max(100 - suma, 0);
    el.textContent = 'Suma de participaciones: ' + suma + '% · Empresa (remanente, nunca se carga a mano): ' + empresa + '%' + (suma > 100 ? ' — excede el 100%' : '');
    el.className = 'pv-status-msg ' + (suma <= 100 ? 'ok' : 'err');
  }

  function recomputarSumaFases() {
    var precio = parseInt(document.getElementById('npPrecio').value, 10) || 0;
    var suma = 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-fase-precio]'), function (input) { suma += parseInt(input.value, 10) || 0; });
    var el = document.getElementById('npFasesSuma');
    el.textContent = 'Suma de fases: ' + suma.toLocaleString('es-CL') + ' / ' + precio.toLocaleString('es-CL') + ' (precio pactado)';
    el.className = 'pv-status-msg ' + (suma === precio && precio > 0 ? 'ok' : 'err');
  }

  function recomputarSumaPagos() {
    var precio = parseInt(document.getElementById('npPrecio').value, 10) || 0;
    var suma = 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-pago-monto]'), function (input) { suma += parseInt(input.value, 10) || 0; });
    var el = document.getElementById('npPagosSuma');
    el.textContent = 'Suma de pagos: ' + suma.toLocaleString('es-CL') + ' / ' + precio.toLocaleString('es-CL') + ' (precio pactado)';
    el.className = 'pv-status-msg ' + (suma === precio && precio > 0 ? 'ok' : 'err');
  }

  function agregarFilaFase() {
    var contenedor = document.getElementById('npFasesLista');
    var wrapper = document.createElement('div');
    wrapper.innerHTML = fasePagoRowHTML('fase');
    var fila = wrapper.firstElementChild;
    contenedor.appendChild(fila);
    fila.querySelector('[data-quitar-fila]').addEventListener('click', function () { fila.remove(); recomputarSumaFases(); });
    fila.querySelector('[data-fase-precio]').addEventListener('input', recomputarSumaFases);
    recomputarSumaFases();
  }

  function agregarFilaPago() {
    var contenedor = document.getElementById('npPagosLista');
    var wrapper = document.createElement('div');
    wrapper.innerHTML = fasePagoRowHTML('pago');
    var fila = wrapper.firstElementChild;
    contenedor.appendChild(fila);
    fila.querySelector('[data-quitar-fila]').addEventListener('click', function () { fila.remove(); recomputarSumaPagos(); });
    fila.querySelector('[data-pago-monto]').addEventListener('input', recomputarSumaPagos);
    recomputarSumaPagos();
  }

  function resetNuevoProyectoForm() {
    var form = document.getElementById('pvNuevoProyectoForm');
    form.reset();
    document.getElementById('npFasesLista').innerHTML = '';
    document.getElementById('npPagosLista').innerHTML = '';
    document.getElementById('npDistribucionLista').innerHTML = '';
    document.getElementById('npFasesSuma').textContent = '';
    document.getElementById('npPagosSuma').textContent = '';
    document.getElementById('npDistribucionSuma').textContent = '';
    document.getElementById('npStatus').textContent = '';
    document.getElementById('npStatus').className = 'pv-status-msg';
    agregarFilaFase();
    agregarFilaPago();
    poblarTipoVentaProyecto();
  }

  function abrirNuevoProyecto() {
    resetNuevoProyectoForm();
    document.getElementById('pvNuevoProyectoOverlay').classList.add('open');
    document.getElementById('pvNuevoProyectoPanel').classList.add('open');
    document.getElementById('pvNuevoProyectoPanel').setAttribute('aria-hidden', 'false');
  }

  function cerrarNuevoProyecto() {
    document.getElementById('pvNuevoProyectoOverlay').classList.remove('open');
    document.getElementById('pvNuevoProyectoPanel').classList.remove('open');
    document.getElementById('pvNuevoProyectoPanel').setAttribute('aria-hidden', 'true');
  }

  function wireNuevoProyecto() {
    document.getElementById('pvNuevoProyectoBtn').addEventListener('click', abrirNuevoProyecto);
    document.getElementById('pvNuevoProyectoCloseBtn').addEventListener('click', cerrarNuevoProyecto);
    document.getElementById('pvNuevoProyectoOverlay').addEventListener('click', cerrarNuevoProyecto);
    document.getElementById('npAgregarFase').addEventListener('click', agregarFilaFase);
    document.getElementById('npAgregarPago').addEventListener('click', agregarFilaPago);
    document.getElementById('npAgregarParticipacion').addEventListener('click', agregarFilaParticipacion);
    // RIO-119 (tercer bloque, item 5, 03/09/2026): un proyecto histórico
    // "permite información incompleta" — la fila vacía de fase/pago que se
    // agrega por defecto tiene inputs `required`, que bloquearían el envío
    // nativo del formulario aunque el JS ya no las exija. Al activar un
    // modo histórico se limpian esas filas (nada que completar a la
    // fuerza); al volver a "flujo normal" se restaura una fila de cada.
    document.getElementById('npModoHistorico').addEventListener('change', function () {
      if (this.value) {
        document.getElementById('npFasesLista').innerHTML = '';
        document.getElementById('npPagosLista').innerHTML = '';
        recomputarSumaFases();
        recomputarSumaPagos();
      } else {
        if (document.querySelectorAll('[data-fase-row]').length === 0) agregarFilaFase();
        if (document.querySelectorAll('[data-pago-row]').length === 0) agregarFilaPago();
      }
    });
    document.getElementById('npMercado').addEventListener('change', poblarTipoVentaProyecto);
    document.getElementById('npPrecio').addEventListener('input', function () { recomputarSumaFases(); recomputarSumaPagos(); });

    document.getElementById('pvNuevoProyectoForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var statusEl = document.getElementById('npStatus');
      statusEl.textContent = '';
      statusEl.className = 'pv-status-msg';

      var precioPactado = parseInt(document.getElementById('npPrecio').value, 10);
      var fases = Array.prototype.map.call(document.querySelectorAll('[data-fase-row]'), function (fila) {
        return {
          nombre: fila.querySelector('[data-fase-nombre]').value.trim(),
          descripcion: fila.querySelector('[data-fase-descripcion]').value.trim() || undefined,
          precioAtribuido: parseInt(fila.querySelector('[data-fase-precio]').value, 10),
        };
      });
      var pagos = Array.prototype.map.call(document.querySelectorAll('[data-pago-row]'), function (fila) {
        return {
          etiqueta: fila.querySelector('[data-pago-etiqueta]').value.trim(),
          monto: parseInt(fila.querySelector('[data-pago-monto]').value, 10),
        };
      });

      // RIO-119 (tercer bloque, item 5, 03/09/2026): un proyecto histórico
      // "permite información incompleta claramente identificada" — nunca
      // exige fases/pagos completos ni que reconcilien con el precio.
      var modoHistorico = document.getElementById('npModoHistorico').value || undefined;
      if (!modoHistorico) {
        if (fases.length === 0) { statusEl.textContent = 'Agregá al menos una fase.'; statusEl.className = 'pv-status-msg err'; return; }
        if (pagos.length === 0) { statusEl.textContent = 'Agregá al menos un pago.'; statusEl.className = 'pv-status-msg err'; return; }
        var sumaFases = fases.reduce(function (s, f) { return s + (f.precioAtribuido || 0); }, 0);
        var sumaPagos = pagos.reduce(function (s, p) { return s + (p.monto || 0); }, 0);
        if (sumaFases !== precioPactado) { statusEl.textContent = 'La suma de las fases debe ser exactamente el precio pactado.'; statusEl.className = 'pv-status-msg err'; return; }
        if (sumaPagos !== precioPactado) { statusEl.textContent = 'La suma de los pagos debe ser exactamente el precio pactado.'; statusEl.className = 'pv-status-msg err'; return; }
      }

      var tipoVentaSel = document.getElementById('npTipoVenta').value;
      if (!tipoVentaSel) { statusEl.textContent = 'Elegí el tipo de venta (equipo o venta directa de Administración).'; statusEl.className = 'pv-status-msg err'; return; }

      // Distribución: opcional (item 5 — "preparación", nunca bloqueante
      // si no se define todavía), pero si administración cargó filas,
      // tiene que cerrar exacto en 100% antes de poder guardar — mismo
      // criterio que valida el servidor (validarDistribucion).
      var filasDistribucion = document.querySelectorAll('[data-participacion-row]');
      var distribucion;
      if (filasDistribucion.length > 0) {
        distribucion = Array.prototype.map.call(filasDistribucion, function (fila) {
          return {
            concepto: fila.querySelector('[data-part-concepto]').value.trim(),
            beneficiarioEmail: fila.querySelector('[data-part-email]').value.trim(),
            porcentaje: parseInt(fila.querySelector('[data-part-porcentaje]').value, 10) || 0,
          };
        });
        var sumaDistribucion = distribucion.reduce(function (s, p) { return s + p.porcentaje; }, 0);
        var faltaBeneficiario = distribucion.some(function (p) { return !p.beneficiarioEmail; });
        if (faltaBeneficiario) { statusEl.textContent = 'Cada participación de la distribución necesita un beneficiario.'; statusEl.className = 'pv-status-msg err'; return; }
        if (sumaDistribucion > 100) { statusEl.textContent = 'La distribución no puede exceder el 100% — no agregues una fila de "empresa", es siempre el remanente.'; statusEl.className = 'pv-status-msg err'; return; }
      }

      var payload = {
        mercado: document.getElementById('npMercado').value,
        cliente: { negocio: document.getElementById('npCliente').value.trim() },
        producto: 'proyecto_personalizado',
        tipoPrecio: 'regular',
        precioPactado: precioPactado,
        nombreProyecto: document.getElementById('npNombre').value.trim(),
        descripcionProyecto: document.getElementById('npDescripcion').value.trim() || undefined,
        notionUrl: document.getElementById('npNotionUrl').value.trim() || undefined,
        fases: fases,
        pagos: pagos,
        distribucion: distribucion,
        modoHistorico: modoHistorico,
      };
      if (tipoVentaSel === 'directa') {
        payload.tipoVenta = 'directa_administracion_sin_supervision';
      } else {
        payload.tipoVenta = 'equipo';
        payload.equipoId = tipoVentaSel.slice('equipo:'.length);
      }

      var submitBtn = document.getElementById('npSubmitBtn');
      submitBtn.disabled = true;
      var r = await apiPost('/interno/api/ventas', payload);
      submitBtn.disabled = false;
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo registrar el proyecto.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      var nuevaVentaId = r.body.data.venta.id;
      cerrarNuevoProyecto();
      await cargarVentas();
      activarTab('ventas');
      abrirDetalleVenta(nuevaVentaId);
    });
  }

  // ── Personas y equipos (segundo bloque de RIO-119, 02/09/2026) ───────
  // Administración de perfiles, rol/mercados/capacidad de vender, equipos,
  // miembros y supervisores — todo lo que antes solo existía sembrado por
  // migración SQL directa. Datos de transferencia cifrados/enmascarados
  // (tercer bloque, item 1) y planes de comisión (tercer bloque, items 2-3)
  // se agregan más abajo.

  var personasCache = [];
  var personasYaCargadas = false;
  var equiposAdminCache = [];
  var equiposAdminYaCargados = false;
  var ROLE_LABEL = { admin: 'Administrador', supervisor: 'Supervisor', ejecutivo: 'Ejecutivo', asistente: 'Asistente' };
  var ACCESO_ESTADO_LABEL = {
    perfil_creado: 'Perfil creado', acceso_pendiente: 'Acceso pendiente', acceso_confirmado: 'Acceso confirmado', desactivado: 'Desactivado',
  };
  var ACCESO_ESTADO_BADGE = { perfil_creado: 'neutral', acceso_pendiente: 'amber', acceso_confirmado: 'green', desactivado: 'red' };
  // RIO-119 (tercer bloque — datos sensibles cifrados): enmascarado
  // GENÉRICO, nunca derivado del valor real — mismo criterio que
  // functions/_shared/crypto.js MASKED_PLACEHOLDER.
  var MASKED_PLACEHOLDER = '••••••••';

  async function cargarPersonas() {
    document.getElementById('pvPersonasResult').innerHTML = '<div class="pv-loading">Cargando personas…</div>';
    var r = await apiFetch('/interno/api/personas');
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvPersonasResult').innerHTML = pvErrorHTML('No se pudieron cargar las personas.');
      return;
    }
    personasCache = r.body.data.personas || [];
    personasYaCargadas = true;
    renderPersonasTabla();
  }

  function renderPersonasTabla() {
    var el = document.getElementById('pvPersonasResult');
    if (personasCache.length === 0) {
      el.innerHTML = pvEmptyHTML('👤', 'Todavía no hay personas registradas.');
      return;
    }
    var rows = personasCache.map(function (p) {
      return (
        '<tr tabindex="0" data-persona-email="' + escapeHtml(p.email) + '">' +
          '<td><span class="pv-cliente-nombre">' + escapeHtml(p.nombre) + '</span><br><span class="pv-mono">' + escapeHtml(p.email) + '</span></td>' +
          '<td>' + (p.role ? escapeHtml(ROLE_LABEL[p.role] || p.role) : '<span class="pv-badge pv-badge--neutral">Sin asignación</span>') + '</td>' +
          '<td>' + (p.allowedMarkets && p.allowedMarkets.length ? p.allowedMarkets.map(escapeHtml).join(', ') : '—') + '</td>' +
          '<td>' + (p.canSell ? 'Sí' : 'No') + '</td>' +
          '<td><span class="pv-badge pv-badge--' + (ACCESO_ESTADO_BADGE[p.accesoEstado] || 'neutral') + '">' + escapeHtml(ACCESO_ESTADO_LABEL[p.accesoEstado] || p.accesoEstado) + '</span></td>' +
        '</tr>'
      );
    }).join('');
    el.innerHTML =
      '<div class="pv-table-wrap"><table class="pv-table">' +
        '<thead><tr><th>Persona</th><th>Rol</th><th>Mercados</th><th>Vende</th><th>Acceso</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>';
    Array.prototype.forEach.call(el.querySelectorAll('tbody tr'), function (tr) {
      tr.addEventListener('click', function () { abrirPersonaEditar(tr.getAttribute('data-persona-email')); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirPersonaEditar(tr.getAttribute('data-persona-email')); } });
    });
  }

  async function cargarEquiposAdminTab() {
    document.getElementById('pvEquiposResult').innerHTML = '<div class="pv-loading">Cargando equipos…</div>';
    var incluirInactivos = document.getElementById('fEquiposInactivos').checked;
    var r = await apiFetch('/interno/api/equipos' + (incluirInactivos ? '?incluirInactivos=1' : ''));
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvEquiposResult').innerHTML = pvErrorHTML('No se pudieron cargar los equipos.');
      return;
    }
    equiposAdminCache = r.body.data.equipos || [];
    equiposAdminYaCargados = true;
    renderEquiposTabla();
  }

  function renderEquiposTabla() {
    var el = document.getElementById('pvEquiposResult');
    if (equiposAdminCache.length === 0) {
      el.innerHTML = pvEmptyHTML('🧑‍🤝‍🧑', 'Todavía no hay equipos registrados.');
      return;
    }
    var rows = equiposAdminCache.map(function (e) {
      return (
        '<tr tabindex="0" data-equipo-id="' + escapeHtml(e.id) + '">' +
          '<td><span class="pv-cliente-nombre">' + escapeHtml(e.nombre) + '</span></td>' +
          '<td><span class="pv-badge pv-badge--neutral">' + escapeHtml(e.mercado) + '</span></td>' +
          '<td><span class="pv-badge pv-badge--' + (e.estado === 'activo' ? 'green' : 'red') + '">' + (e.estado === 'activo' ? 'Activo' : 'Inactivo') + '</span></td>' +
        '</tr>'
      );
    }).join('');
    el.innerHTML =
      '<div class="pv-table-wrap"><table class="pv-table">' +
        '<thead><tr><th>Equipo</th><th>Mercado</th><th>Estado</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>';
    Array.prototype.forEach.call(el.querySelectorAll('tbody tr'), function (tr) {
      tr.addEventListener('click', function () { abrirEquipoGestion(tr.getAttribute('data-equipo-id')); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirEquipoGestion(tr.getAttribute('data-equipo-id')); } });
    });
  }

  // ── Panel de persona (crear / editar) ────────────────────────────────

  function cerrarPersonaPanel() {
    document.getElementById('pvPersonaOverlay').classList.remove('open');
    document.getElementById('pvPersonaPanel').classList.remove('open');
    document.getElementById('pvPersonaPanel').setAttribute('aria-hidden', 'true');
  }

  function abrirPersonaCrear() {
    document.getElementById('pvPersonaTitulo').textContent = 'Nueva persona';
    document.getElementById('pvPersonaCrearForm').style.display = '';
    document.getElementById('pvPersonaEditarWrap').style.display = 'none';
    document.getElementById('pvPersonaCrearForm').reset();
    document.getElementById('ppMercadoCL').checked = true;
    document.getElementById('ppMercadoAR').checked = false;
    document.getElementById('ppCrearStatus').textContent = '';
    document.getElementById('pvPersonaOverlay').classList.add('open');
    document.getElementById('pvPersonaPanel').classList.add('open');
    document.getElementById('pvPersonaPanel').setAttribute('aria-hidden', 'false');
  }

  function abrirPersonaEditar(email) {
    var persona = personasCache.find(function (p) { return p.email === email; });
    if (!persona) return;
    document.getElementById('pvPersonaTitulo').textContent = persona.nombre;
    document.getElementById('pvPersonaCrearForm').style.display = 'none';
    document.getElementById('pvPersonaEditarWrap').style.display = '';
    document.getElementById('pvPersonaEditarWrap').setAttribute('data-email', email);

    document.getElementById('peNombre').value = persona.nombre || '';
    // RIO-119 (tercer bloque — RUT/DNI protegido): el valor real NUNCA
    // viaja en el listado — el campo arranca vacío ("dejar vacío = no
    // cambiar"), solo un estado enmascarado indica si hay uno cargado.
    document.getElementById('peDocumento').value = '';
    document.getElementById('peDocumentoEstado').textContent = persona.tieneDocumento ? MASKED_PLACEHOLDER : 'Sin RUT/DNI cargado';
    document.getElementById('peTelefono').value = persona.telefono || '';
    document.getElementById('peWhatsapp').value = persona.whatsappLaboral || '';
    document.getElementById('peAcceso').value = persona.accesoEstado || 'perfil_creado';
    document.getElementById('peStatus').textContent = '';

    document.getElementById('paRole').value = persona.role || 'ejecutivo';
    document.getElementById('paMercadoCL').checked = (persona.allowedMarkets || []).indexOf('CL') !== -1;
    document.getElementById('paMercadoAR').checked = (persona.allowedMarkets || []).indexOf('AR') !== -1;
    document.getElementById('paCanSell').checked = !!persona.canSell;
    document.getElementById('paCanReceiveAdvance').checked = !!persona.canReceiveCommissionAdvance;
    document.getElementById('paUserStatusInactivo').checked = persona.userStatus === 'inactivo';
    document.getElementById('paMotivo').value = '';
    document.getElementById('paStatus').textContent = '';

    document.getElementById('pcNuevoEmail').value = '';
    document.getElementById('pcMotivo').value = '';
    document.getElementById('pcStatus').textContent = '';
    document.getElementById('pvNuevoDatoTransferenciaForm').reset();
    document.getElementById('dtStatus').textContent = '';

    document.getElementById('pvPersonaOverlay').classList.add('open');
    document.getElementById('pvPersonaPanel').classList.add('open');
    document.getElementById('pvPersonaPanel').setAttribute('aria-hidden', 'false');

    cargarDatosTransferencia(email);
  }

  // RIO-119 (tercer bloque — datos de transferencia protegidos,
  // 02/09/2026): la lista SIEMPRE llega enmascarada del servidor (nunca se
  // descifra acá sin una acción explícita de "Revelar").
  async function cargarDatosTransferencia(email) {
    var el = document.getElementById('pvDatosTransferenciaLista');
    el.innerHTML = '<div class="pv-loading">Cargando…</div>';
    var r = await apiFetch('/interno/api/personas/' + encodeURIComponent(email) + '/datos-transferencia');
    if (!r.ok || !r.body || !r.body.ok) { el.innerHTML = pvErrorHTML('No se pudieron cargar los datos de transferencia.'); return; }
    var registros = r.body.data.datosTransferencia || [];
    if (registros.length === 0) { el.innerHTML = '<p class="pv-materiales-vacio">Todavía no hay datos de transferencia cargados.</p>'; return; }
    el.innerHTML = registros.map(function (reg) {
      return (
        '<div class="pv-notif-card" data-dt-id="' + escapeHtml(reg.id) + '">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(reg.bancoProveedor) + ' — <span class="pv-badge pv-badge--neutral">' + escapeHtml(reg.pais) + ' / ' + escapeHtml(reg.moneda) + '</span></span>' +
          '</div>' +
          '<div class="pv-notif-meta" data-dt-detalle>Titular: ' + escapeHtml(reg.titular || '—') + ' · Identificación: ' + escapeHtml(reg.identificacion || '—') + ' · Cuenta: ' + escapeHtml(reg.numeroCuenta || '—') + ' · Alias: ' + escapeHtml(reg.alias || '—') + '</div>' +
          '<div class="pv-btn-row">' +
            '<button type="button" class="pv-btn" data-revelar-dt="' + escapeHtml(reg.id) + '">Revelar</button>' +
            '<button type="button" class="pv-btn pv-btn--danger" data-eliminar-dt="' + escapeHtml(reg.id) + '">Eliminar</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-revelar-dt]'), function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-revelar-dt');
        btn.disabled = true;
        var r2 = await apiPost('/interno/api/personas/' + encodeURIComponent(email) + '/datos-transferencia/' + encodeURIComponent(id), { action: 'revelar' });
        btn.disabled = false;
        if (!r2.ok || !r2.body || !r2.body.ok) { alert((r2.body && r2.body.error && r2.body.error.message) || 'No se pudo revelar.'); return; }
        var d = r2.body.data;
        var detalleEl = el.querySelector('[data-dt-id="' + id + '"] [data-dt-detalle]');
        detalleEl.textContent = 'Titular: ' + (d.titular || '—') + ' · Identificación: ' + (d.identificacion || '—') + ' · Cuenta: ' + (d.numeroCuenta || '—') + ' · Alias: ' + (d.alias || '—') + (d.observaciones ? ' · Obs: ' + d.observaciones : '');
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-eliminar-dt]'), function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('¿Eliminar este registro de transferencia? Queda desactivado, nunca se borra del historial.')) return;
        var id = btn.getAttribute('data-eliminar-dt');
        btn.disabled = true;
        var r2 = await apiPost('/interno/api/personas/' + encodeURIComponent(email) + '/datos-transferencia/' + encodeURIComponent(id), { action: 'eliminar' });
        if (!r2.ok || !r2.body || !r2.body.ok) { alert((r2.body && r2.body.error && r2.body.error.message) || 'No se pudo eliminar.'); btn.disabled = false; return; }
        await cargarDatosTransferencia(email);
      });
    });
  }

  function mercadosSeleccionados(prefijo) {
    var mercados = [];
    if (document.getElementById(prefijo + 'MercadoCL').checked) mercados.push('CL');
    if (document.getElementById(prefijo + 'MercadoAR').checked) mercados.push('AR');
    return mercados;
  }

  function wirePersonasEquipos() {
    document.getElementById('pvNuevaPersonaBtn').addEventListener('click', abrirPersonaCrear);
    document.getElementById('pvPersonaCloseBtn').addEventListener('click', cerrarPersonaPanel);
    document.getElementById('pvPersonaOverlay').addEventListener('click', cerrarPersonaPanel);

    document.getElementById('pvPersonaCrearForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var statusEl = document.getElementById('ppCrearStatus');
      var mercados = mercadosSeleccionados('pp');
      if (mercados.length === 0) { statusEl.textContent = 'Elegí al menos un mercado.'; statusEl.className = 'pv-status-msg err'; return; }
      var payload = {
        email: document.getElementById('ppEmail').value.trim(),
        nombre: document.getElementById('ppNombre').value.trim(),
        documentoIdentidad: document.getElementById('ppDocumento').value.trim() || undefined,
        telefono: document.getElementById('ppTelefono').value.trim() || undefined,
        whatsappLaboral: document.getElementById('ppWhatsapp').value.trim() || undefined,
        role: document.getElementById('ppRole').value,
        allowedMarkets: mercados,
        canSell: document.getElementById('ppCanSell').checked,
      };
      var r = await apiPost('/interno/api/personas', payload);
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo crear la persona.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      cerrarPersonaPanel();
      await cargarPersonas();
    });

    document.getElementById('pvPersonaEditarPerfilForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = document.getElementById('pvPersonaEditarWrap').getAttribute('data-email');
      var statusEl = document.getElementById('peStatus');
      var r = await apiPost('/interno/api/personas/' + encodeURIComponent(email), {
        action: 'editar-perfil',
        nombre: document.getElementById('peNombre').value.trim(),
        documentoIdentidad: document.getElementById('peDocumento').value.trim() || undefined,
        telefono: document.getElementById('peTelefono').value.trim() || undefined,
        whatsappLaboral: document.getElementById('peWhatsapp').value.trim() || undefined,
        accesoEstado: document.getElementById('peAcceso').value,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo guardar.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      statusEl.textContent = 'Perfil guardado.';
      statusEl.className = 'pv-status-msg ok';
      await cargarPersonas();
    });

    document.getElementById('pvPersonaAsignacionForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = document.getElementById('pvPersonaEditarWrap').getAttribute('data-email');
      var statusEl = document.getElementById('paStatus');
      var mercados = mercadosSeleccionados('pa');
      if (mercados.length === 0) { statusEl.textContent = 'Elegí al menos un mercado.'; statusEl.className = 'pv-status-msg err'; return; }
      var r = await apiPost('/interno/api/personas/' + encodeURIComponent(email), {
        action: 'cambiar-asignacion',
        role: document.getElementById('paRole').value,
        allowedMarkets: mercados,
        canSell: document.getElementById('paCanSell').checked,
        canReceiveCommissionAdvance: document.getElementById('paCanReceiveAdvance').checked,
        userStatus: document.getElementById('paUserStatusInactivo').checked ? 'inactivo' : 'activo',
        motivo: document.getElementById('paMotivo').value.trim() || undefined,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo guardar la nueva asignación.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      statusEl.textContent = 'Nueva asignación guardada.';
      statusEl.className = 'pv-status-msg ok';
      await cargarPersonas();
    });

    // RIO-119 (tercer bloque — RUT/DNI protegido): revela el valor real
    // UNA vez, solo en memoria del navegador — nunca se guarda en
    // personasCache ni se recarga después sin volver a pedirlo.
    document.getElementById('peRevelarDocumentoBtn').addEventListener('click', async function () {
      var email = document.getElementById('pvPersonaEditarWrap').getAttribute('data-email');
      var estadoEl = document.getElementById('peDocumentoEstado');
      var btn = document.getElementById('peRevelarDocumentoBtn');
      btn.disabled = true;
      var r = await apiPost('/interno/api/personas/' + encodeURIComponent(email), { action: 'revelar-documento' });
      btn.disabled = false;
      if (!r.ok || !r.body || !r.body.ok) {
        alert((r.body && r.body.error && r.body.error.message) || 'No se pudo revelar el documento.');
        return;
      }
      estadoEl.textContent = r.body.data.documentoIdentidad || 'Sin RUT/DNI cargado';
    });

    document.getElementById('pvNuevoDatoTransferenciaForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = document.getElementById('pvPersonaEditarWrap').getAttribute('data-email');
      var statusEl = document.getElementById('dtStatus');
      var r = await apiPost('/interno/api/personas/' + encodeURIComponent(email) + '/datos-transferencia', {
        pais: document.getElementById('dtPais').value,
        moneda: document.getElementById('dtMoneda').value,
        bancoProveedor: document.getElementById('dtBanco').value.trim(),
        tipoCuenta: document.getElementById('dtTipoCuenta').value.trim() || undefined,
        tipoDocumento: document.getElementById('dtTipoDocumento').value.trim() || undefined,
        titular: document.getElementById('dtTitular').value.trim() || undefined,
        identificacion: document.getElementById('dtIdentificacion').value.trim() || undefined,
        numeroCuenta: document.getElementById('dtNumeroCuenta').value.trim() || undefined,
        alias: document.getElementById('dtAlias').value.trim() || undefined,
        observaciones: document.getElementById('dtObservaciones').value.trim() || undefined,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo agregar el registro.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      document.getElementById('pvNuevoDatoTransferenciaForm').reset();
      statusEl.textContent = '';
      await cargarDatosTransferencia(email);
    });

    document.getElementById('pvPersonaCorreoForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = document.getElementById('pvPersonaEditarWrap').getAttribute('data-email');
      var statusEl = document.getElementById('pcStatus');
      var nuevoEmail = document.getElementById('pcNuevoEmail').value.trim();
      if (!confirm('¿Confirmás cambiar el correo de esta persona a "' + nuevoEmail + '"? Sus ventas, equipos y comisiones vigentes se actualizan automáticamente.')) return;
      var r = await apiPost('/interno/api/personas/' + encodeURIComponent(email), {
        action: 'cambiar-correo', nuevoEmail: nuevoEmail, motivo: document.getElementById('pcMotivo').value.trim() || undefined,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo cambiar el correo.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      cerrarPersonaPanel();
      await cargarPersonas();
    });

    // ── Equipos ──
    document.getElementById('pvNuevoEquipoBtn').addEventListener('click', abrirEquipoCrear);
    document.getElementById('pvEquipoCloseBtn').addEventListener('click', cerrarEquipoPanel);
    document.getElementById('pvEquipoOverlay').addEventListener('click', cerrarEquipoPanel);

    document.getElementById('pvEquipoCrearForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var statusEl = document.getElementById('peqCrearStatus');
      var r = await apiPost('/interno/api/equipos', {
        nombre: document.getElementById('peqNombre').value.trim(),
        mercado: document.getElementById('peqMercado').value,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo crear el equipo.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      cerrarEquipoPanel();
      await cargarEquiposAdminTab();
    });

    document.getElementById('pvEquipoDesactivarBtn').addEventListener('click', function () { cambiarEstadoEquipo('desactivar'); });
    document.getElementById('pvEquipoActivarBtn').addEventListener('click', function () { cambiarEstadoEquipo('activar'); });

    document.getElementById('pvEquipoAgregarMiembroForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var equipoId = document.getElementById('pvEquipoGestionWrap').getAttribute('data-equipo-id');
      var statusEl = document.getElementById('peqMiembroStatus');
      var email = document.getElementById('peqMiembroEmail').value.trim();
      var r = await apiPost('/interno/api/equipos/' + encodeURIComponent(equipoId) + '/miembros', { action: 'agregar', usuarioEmail: email });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo agregar.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      statusEl.textContent = ''; document.getElementById('peqMiembroEmail').value = '';
      await cargarMiembrosEquipo(equipoId);
    });

    document.getElementById('pvEquipoAgregarSupervisorForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var equipoId = document.getElementById('pvEquipoGestionWrap').getAttribute('data-equipo-id');
      var statusEl = document.getElementById('peqSupervisorStatus');
      var email = document.getElementById('peqSupervisorEmail').value.trim();
      var esPrincipal = document.getElementById('peqSupervisorPrincipal').checked;
      var r = await apiPost('/interno/api/equipos/' + encodeURIComponent(equipoId) + '/supervisores', { action: 'agregar', usuarioEmail: email, esPrincipal: esPrincipal });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo agregar.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      statusEl.textContent = ''; document.getElementById('peqSupervisorEmail').value = ''; document.getElementById('peqSupervisorPrincipal').checked = false;
      await cargarSupervisoresEquipo(equipoId);
    });
  }

  // ── Panel de equipo (crear / gestionar) ──────────────────────────────

  function cerrarEquipoPanel() {
    document.getElementById('pvEquipoOverlay').classList.remove('open');
    document.getElementById('pvEquipoPanel').classList.remove('open');
    document.getElementById('pvEquipoPanel').setAttribute('aria-hidden', 'true');
  }

  function abrirEquipoCrear() {
    document.getElementById('pvEquipoTitulo').textContent = 'Nuevo equipo';
    document.getElementById('pvEquipoCrearForm').style.display = '';
    document.getElementById('pvEquipoGestionWrap').style.display = 'none';
    document.getElementById('pvEquipoCrearForm').reset();
    document.getElementById('peqCrearStatus').textContent = '';
    document.getElementById('pvEquipoOverlay').classList.add('open');
    document.getElementById('pvEquipoPanel').classList.add('open');
    document.getElementById('pvEquipoPanel').setAttribute('aria-hidden', 'false');
  }

  async function abrirEquipoGestion(equipoId) {
    var equipo = equiposAdminCache.find(function (e) { return e.id === equipoId; });
    if (!equipo) return;
    document.getElementById('pvEquipoTitulo').textContent = equipo.nombre + ' (' + equipo.mercado + ')';
    document.getElementById('pvEquipoCrearForm').style.display = 'none';
    document.getElementById('pvEquipoGestionWrap').style.display = '';
    document.getElementById('pvEquipoGestionWrap').setAttribute('data-equipo-id', equipoId);
    document.getElementById('pvEquipoDesactivarBtn').style.display = equipo.estado === 'activo' ? '' : 'none';
    document.getElementById('pvEquipoActivarBtn').style.display = equipo.estado === 'activo' ? 'none' : '';

    document.getElementById('pvEquipoOverlay').classList.add('open');
    document.getElementById('pvEquipoPanel').classList.add('open');
    document.getElementById('pvEquipoPanel').setAttribute('aria-hidden', 'false');

    await cargarMiembrosEquipo(equipoId);
    await cargarSupervisoresEquipo(equipoId);
  }

  async function cambiarEstadoEquipo(accion) {
    var equipoId = document.getElementById('pvEquipoGestionWrap').getAttribute('data-equipo-id');
    var r = await apiPost('/interno/api/equipos/' + encodeURIComponent(equipoId), { action: accion });
    if (!r.ok || !r.body || !r.body.ok) {
      alert((r.body && r.body.error && r.body.error.message) || 'No se pudo cambiar el estado del equipo.');
      return;
    }
    document.getElementById('pvEquipoDesactivarBtn').style.display = accion === 'activar' ? '' : 'none';
    document.getElementById('pvEquipoActivarBtn').style.display = accion === 'activar' ? 'none' : '';
    await cargarEquiposAdminTab();
  }

  async function cargarMiembrosEquipo(equipoId) {
    var el = document.getElementById('pvEquipoMiembrosLista');
    el.innerHTML = '<div class="pv-loading">Cargando…</div>';
    var r = await apiFetch('/interno/api/equipos/' + encodeURIComponent(equipoId) + '/miembros');
    if (!r.ok || !r.body || !r.body.ok) { el.innerHTML = pvErrorHTML('No se pudieron cargar los miembros.'); return; }
    var miembros = r.body.data.miembros || [];
    if (miembros.length === 0) { el.innerHTML = '<p class="pv-materiales-vacio">Todavía no hay miembros.</p>'; return; }
    el.innerHTML = miembros.map(function (m) {
      return (
        '<div class="pv-notif-card">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(nombreParaMostrar(m.usuarioNombre)) + ' <span class="pv-mono">' + escapeHtml(m.usuarioEmail) + '</span></span>' +
            '<button type="button" class="pv-btn pv-btn--danger" data-quitar-miembro="' + escapeHtml(m.usuarioEmail) + '">Quitar</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-quitar-miembro]'), function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var r2 = await apiPost('/interno/api/equipos/' + encodeURIComponent(equipoId) + '/miembros', { action: 'quitar', usuarioEmail: btn.getAttribute('data-quitar-miembro') });
        if (!r2.ok || !r2.body || !r2.body.ok) { alert((r2.body && r2.body.error && r2.body.error.message) || 'No se pudo quitar.'); btn.disabled = false; return; }
        await cargarMiembrosEquipo(equipoId);
      });
    });
  }

  async function cargarSupervisoresEquipo(equipoId) {
    var el = document.getElementById('pvEquipoSupervisoresLista');
    el.innerHTML = '<div class="pv-loading">Cargando…</div>';
    var r = await apiFetch('/interno/api/equipos/' + encodeURIComponent(equipoId) + '/supervisores');
    if (!r.ok || !r.body || !r.body.ok) { el.innerHTML = pvErrorHTML('No se pudieron cargar los supervisores.'); return; }
    var supervisores = r.body.data.supervisores || [];
    if (supervisores.length === 0) { el.innerHTML = '<p class="pv-materiales-vacio">Todavía no hay supervisores.</p>'; return; }
    el.innerHTML = supervisores.map(function (s) {
      return (
        '<div class="pv-notif-card">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(nombreParaMostrar(s.usuarioNombre)) + ' <span class="pv-mono">' + escapeHtml(s.usuarioEmail) + '</span>' +
              (s.esPrincipal ? ' <span class="pv-badge pv-badge--purple">Principal</span>' : '') + '</span>' +
          '</div>' +
          '<div class="pv-btn-row">' +
            (s.esPrincipal ? '' : '<button type="button" class="pv-btn" data-marcar-principal="' + escapeHtml(s.usuarioEmail) + '">Marcar principal</button>') +
            '<button type="button" class="pv-btn pv-btn--danger" data-quitar-supervisor="' + escapeHtml(s.usuarioEmail) + '">Quitar</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-quitar-supervisor]'), function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var r2 = await apiPost('/interno/api/equipos/' + encodeURIComponent(equipoId) + '/supervisores', { action: 'quitar', usuarioEmail: btn.getAttribute('data-quitar-supervisor') });
        if (!r2.ok || !r2.body || !r2.body.ok) { alert((r2.body && r2.body.error && r2.body.error.message) || 'No se pudo quitar.'); btn.disabled = false; return; }
        await cargarSupervisoresEquipo(equipoId);
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-marcar-principal]'), function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var r2 = await apiPost('/interno/api/equipos/' + encodeURIComponent(equipoId) + '/supervisores', { action: 'marcar-principal', usuarioEmail: btn.getAttribute('data-marcar-principal') });
        if (!r2.ok || !r2.body || !r2.body.ok) { alert((r2.body && r2.body.error && r2.body.error.message) || 'No se pudo marcar como principal.'); btn.disabled = false; return; }
        await cargarSupervisoresEquipo(equipoId);
      });
    });
  }

  // ── Planes de comisión (tercer bloque de RIO-119, items 2-3, 02/09/2026) ──
  // Un plan es una DEFINICIÓN (tipo, porcentaje, base, alcance de
  // producto/mercado) — nunca se muta un porcentaje in place, "nueva
  // versión" cierra el plan viejo (consultable como historial) y crea uno
  // nuevo. La asignación a una persona concreta, con vigencia, es un paso
  // aparte. "Empresa" nunca aparece acá como fila — es siempre el
  // remanente implícito.

  var planesCache = [];
  var TIPO_PLAN_LABEL = { comercial: 'Comercial', supervision: 'Supervisión', realizacion: 'Realización', desarrollo: 'Desarrollo', produccion: 'Producción' };
  var CONTEXTO_PLAN_LABEL = { solo: 'Solo (sin practicante)', responsable_con_practicante: 'Responsable, con practicante', practicante: 'Practicante' };

  async function cargarPlanesComision() {
    document.getElementById('pvPlanesResult').innerHTML = '<div class="pv-loading">Cargando planes…</div>';
    var r = await apiFetch('/interno/api/planes-comision');
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvPlanesResult').innerHTML = pvErrorHTML('No se pudieron cargar los planes.');
      return;
    }
    planesCache = r.body.data.planes || [];
    renderPlanesLista();
  }

  function renderPlanesLista() {
    var el = document.getElementById('pvPlanesResult');
    var incluirInactivos = document.getElementById('fPlanesInactivos').checked;
    var visibles = planesCache.filter(function (p) { return incluirInactivos || p.estado === 'activo'; });
    if (visibles.length === 0) {
      el.innerHTML = pvEmptyHTML('💰', 'Todavía no hay planes de comisión registrados.');
      return;
    }
    el.innerHTML = visibles.map(function (p) {
      return (
        '<div class="pv-notif-card" tabindex="0" data-plan-id="' + escapeHtml(p.id) + '">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(TIPO_PLAN_LABEL[p.tipo] || p.tipo) + (p.contextoRealizacion ? ' — ' + escapeHtml(CONTEXTO_PLAN_LABEL[p.contextoRealizacion] || p.contextoRealizacion) : '') +
              ' — <strong>' + p.porcentaje + '%</strong></span>' +
            '<span class="pv-badge pv-badge--' + (p.estado === 'activo' ? 'green' : 'red') + '">' + (p.estado === 'activo' ? 'Activo' : 'Inactivo') + '</span>' +
          '</div>' +
          '<div style="font-size:.82rem;color:var(--muted);">Base: ' + escapeHtml(p.base) + ' · Productos: ' + escapeHtml(p.productosAlcanzados.join(', ')) + ' · Mercados: ' + escapeHtml(p.mercadosAlcanzados.join(', ')) + '</div>' +
        '</div>'
      );
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-plan-id]'), function (card) {
      card.addEventListener('click', function () { abrirPlanGestion(card.getAttribute('data-plan-id')); });
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirPlanGestion(card.getAttribute('data-plan-id')); } });
    });
  }

  function cerrarPlanPanel() {
    document.getElementById('pvPlanOverlay').classList.remove('open');
    document.getElementById('pvPlanPanel').classList.remove('open');
    document.getElementById('pvPlanPanel').setAttribute('aria-hidden', 'true');
  }

  function abrirPlanCrear() {
    document.getElementById('pvPlanTitulo').textContent = 'Nuevo plan';
    document.getElementById('pvPlanCrearForm').style.display = '';
    document.getElementById('pvPlanGestionWrap').style.display = 'none';
    document.getElementById('pvPlanCrearForm').reset();
    document.getElementById('plContextoWrap').style.display = document.getElementById('plTipo').value === 'realizacion' ? '' : 'none';
    document.getElementById('plCrearStatus').textContent = '';
    document.getElementById('pvPlanOverlay').classList.add('open');
    document.getElementById('pvPlanPanel').classList.add('open');
    document.getElementById('pvPlanPanel').setAttribute('aria-hidden', 'false');
  }

  async function abrirPlanGestion(planId) {
    var plan = planesCache.find(function (p) { return p.id === planId; });
    if (!plan) return;
    document.getElementById('pvPlanTitulo').textContent = (TIPO_PLAN_LABEL[plan.tipo] || plan.tipo) + ' — ' + plan.porcentaje + '%';
    document.getElementById('pvPlanCrearForm').style.display = 'none';
    document.getElementById('pvPlanGestionWrap').style.display = '';
    document.getElementById('pvPlanGestionWrap').setAttribute('data-plan-id', planId);
    document.getElementById('pvPlanDesactivarBtn').style.display = plan.estado === 'activo' ? '' : 'none';
    document.getElementById('pvPlanResumen').innerHTML =
      '<div style="font-size:.85rem;">' +
        '<div><strong>Base:</strong> ' + escapeHtml(plan.base) + '</div>' +
        '<div><strong>Productos:</strong> ' + escapeHtml(plan.productosAlcanzados.join(', ')) + '</div>' +
        '<div><strong>Mercados:</strong> ' + escapeHtml(plan.mercadosAlcanzados.join(', ')) + '</div>' +
        (plan.note ? '<div><strong>Nota:</strong> ' + escapeHtml(plan.note) + '</div>' : '') +
      '</div>';
    document.getElementById('plvPorcentaje').value = plan.porcentaje;
    document.getElementById('plvStatus').textContent = '';
    document.getElementById('ppcStatus').textContent = '';
    document.getElementById('pvPlanAsignarForm').reset();

    document.getElementById('pvPlanOverlay').classList.add('open');
    document.getElementById('pvPlanPanel').classList.add('open');
    document.getElementById('pvPlanPanel').setAttribute('aria-hidden', 'false');

    await cargarAsignacionesPlan(planId);
  }

  async function cargarAsignacionesPlan(planId) {
    var el = document.getElementById('pvPlanAsignacionesLista');
    el.innerHTML = '<div class="pv-loading">Cargando…</div>';
    var r = await apiFetch('/interno/api/planes-comision/' + encodeURIComponent(planId) + '/asignaciones');
    if (!r.ok || !r.body || !r.body.ok) { el.innerHTML = pvErrorHTML('No se pudieron cargar las asignaciones.'); return; }
    var asignaciones = (r.body.data.asignaciones || []).filter(function (a) { return !a.validUntil; });
    if (asignaciones.length === 0) { el.innerHTML = '<p class="pv-materiales-vacio">Todavía no hay asignaciones vigentes.</p>'; return; }
    el.innerHTML = asignaciones.map(function (a) {
      return (
        '<div class="pv-notif-card">' +
          '<div class="pv-notif-head">' +
            '<span>' + escapeHtml(nombreParaMostrar(a.usuarioNombre)) + ' <span class="pv-mono">' + escapeHtml(a.usuarioEmail) + '</span></span>' +
            '<button type="button" class="pv-btn pv-btn--danger" data-cerrar-asignacion="' + escapeHtml(a.id) + '">Cerrar</button>' +
          '</div>' +
          '<div style="font-size:.78rem;color:var(--muted);">Desde ' + escapeHtml(a.validFrom) + (a.validUntil ? ' hasta ' + escapeHtml(a.validUntil) : '') + '</div>' +
        '</div>'
      );
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-cerrar-asignacion]'), function (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var r2 = await apiPost('/interno/api/planes-comision/' + encodeURIComponent(planId) + '/asignaciones', { action: 'cerrar', id: btn.getAttribute('data-cerrar-asignacion') });
        if (!r2.ok || !r2.body || !r2.body.ok) { alert((r2.body && r2.body.error && r2.body.error.message) || 'No se pudo cerrar.'); btn.disabled = false; return; }
        await cargarAsignacionesPlan(planId);
      });
    });
  }

  function wirePlanesComision() {
    document.getElementById('pvNuevoPlanBtn').addEventListener('click', abrirPlanCrear);
    document.getElementById('pvPlanCloseBtn').addEventListener('click', cerrarPlanPanel);
    document.getElementById('pvPlanOverlay').addEventListener('click', cerrarPlanPanel);
    document.getElementById('plTipo').addEventListener('change', function () {
      document.getElementById('plContextoWrap').style.display = this.value === 'realizacion' ? '' : 'none';
    });

    document.getElementById('pvPlanCrearForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var statusEl = document.getElementById('plCrearStatus');
      var tipo = document.getElementById('plTipo').value;
      var productos = document.getElementById('plProductos').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var mercados = document.getElementById('plMercados').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var r = await apiPost('/interno/api/planes-comision', {
        tipo: tipo,
        contextoRealizacion: tipo === 'realizacion' ? document.getElementById('plContexto').value : undefined,
        porcentaje: parseInt(document.getElementById('plPorcentaje').value, 10),
        base: document.getElementById('plBase').value,
        productosAlcanzados: productos,
        mercadosAlcanzados: mercados,
        note: document.getElementById('plNote').value.trim() || undefined,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo crear el plan.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      cerrarPlanPanel();
      await cargarPlanesComision();
    });

    document.getElementById('pvPlanDesactivarBtn').addEventListener('click', async function () {
      var planId = document.getElementById('pvPlanGestionWrap').getAttribute('data-plan-id');
      if (!confirm('¿Desactivar este plan? Deja de poder asignarse a operaciones futuras.')) return;
      var r = await apiPost('/interno/api/planes-comision/' + encodeURIComponent(planId), { action: 'desactivar' });
      if (!r.ok || !r.body || !r.body.ok) { alert((r.body && r.body.error && r.body.error.message) || 'No se pudo desactivar.'); return; }
      cerrarPlanPanel();
      await cargarPlanesComision();
    });

    document.getElementById('pvPlanNuevaVersionForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var planId = document.getElementById('pvPlanGestionWrap').getAttribute('data-plan-id');
      var statusEl = document.getElementById('plvStatus');
      var r = await apiPost('/interno/api/planes-comision/' + encodeURIComponent(planId), {
        action: 'nueva-version',
        porcentaje: parseInt(document.getElementById('plvPorcentaje').value, 10),
        motivo: document.getElementById('plvMotivo').value.trim() || undefined,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo crear la nueva versión.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      cerrarPlanPanel();
      await cargarPlanesComision();
    });

    document.getElementById('pvPlanAsignarForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var planId = document.getElementById('pvPlanGestionWrap').getAttribute('data-plan-id');
      var statusEl = document.getElementById('ppcStatus');
      var r = await apiPost('/interno/api/planes-comision/' + encodeURIComponent(planId) + '/asignaciones', {
        action: 'asignar',
        usuarioEmail: document.getElementById('ppcEmail').value.trim(),
        validFrom: document.getElementById('ppcDesde').value || undefined,
        validUntil: document.getElementById('ppcHasta').value || undefined,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        statusEl.textContent = (r.body && r.body.error && r.body.error.message) || 'No se pudo asignar.';
        statusEl.className = 'pv-status-msg err';
        return;
      }
      statusEl.textContent = '';
      document.getElementById('pvPlanAsignarForm').reset();
      await cargarAsignacionesPlan(planId);
    });
  }
})();
