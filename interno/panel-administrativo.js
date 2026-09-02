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
    await cargarVentas();
    await cargarNotificacionesResumen();
  });

  function wireTabs() {
    var btnVentas = document.getElementById('pvTabVentasBtn');
    var btnNotif = document.getElementById('pvTabNotifBtn');
    btnVentas.addEventListener('click', function () { activarTab('ventas'); });
    btnNotif.addEventListener('click', function () {
      activarTab('notif');
      cargarNotificaciones();
    });
    document.getElementById('fNotifPendientes').addEventListener('change', cargarNotificaciones);
  }

  function activarTab(nombre) {
    var esVentas = nombre === 'ventas';
    document.getElementById('pvTabVentasBtn').classList.toggle('active', esVentas);
    document.getElementById('pvTabVentasBtn').setAttribute('aria-selected', String(esVentas));
    document.getElementById('pvTabNotifBtn').classList.toggle('active', !esVentas);
    document.getElementById('pvTabNotifBtn').setAttribute('aria-selected', String(!esVentas));
    document.getElementById('pvTabVentas').classList.toggle('active', esVentas);
    document.getElementById('pvTabNotif').classList.toggle('active', !esVentas);
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
          '<td>' + escapeHtml(PRODUCTO_LABEL[v.producto] || v.producto) + '<br><span class="pv-badge pv-badge--neutral">' + escapeHtml(v.mercado) + '</span></td>' +
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
    if (c.materialesEstado !== 'completos') {
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
            '<span class="pv-componente-titulo">' + escapeHtml(c.tipo) + '</span>' +
            '<span class="pv-badge pv-badge--blue">' + escapeHtml(COMPONENTE_ESTADO_LABEL[c.estadoActual] || c.estadoActual) + '</span>' +
          '</div>' +
          '<div class="pv-componente-meta">Precio atribuido: ' + fmtMoneda(c.precioAtribuido, detalle.venta.moneda) + '</div>' +
          gateHTML +
          accionesComponenteHTML(c) +
          renderMaterialesHTML(c) +
          costoDirectoFormHTML(c) +
        '</div>'
      );
    }).join('');

    var pagosHTML = detalle.pagosEsperados.map(function (p) { return renderPagoAdminHTML(detalle.venta.id, p, detalle.venta.moneda); }).join('');

    var historialPromise = renderHistorialHTML(detalle.venta.id);
    var antecedentesHTML = renderAntecedentesHTML(detalle);

    return historialPromise.then(function (historialHTML) {
      return (
        '<div class="pv-detail-section"><p class="pv-detail-section-title">Venta</p>' +
          '<dl class="pv-kv">' +
            '<dt>Producto</dt><dd>' + escapeHtml(PRODUCTO_LABEL[detalle.venta.producto] || detalle.venta.producto) + '</dd>' +
            '<dt>Mercado</dt><dd>' + escapeHtml(detalle.venta.mercado) + '</dd>' +
            '<dt>Precio pactado</dt><dd>' + fmtMoneda(detalle.venta.precioPactado, detalle.venta.moneda) + '</dd>' +
            '<dt>Fecha</dt><dd>' + fmtFecha(detalle.venta.createdAt) + '</dd>' +
            renderTipoVentaSupervisionHTML(detalle.venta) +
          '</dl>' +
          costoMedioPagoFormHTML(detalle.venta.id) +
        '</div>' +
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

  function renderPagoAdminHTML(ventaId, pago, moneda) {
    var badgeClass = pago.estado === 'acreditado' ? 'green' : (pago.estado === 'informado' ? 'blue' : 'neutral');
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
          '<span class="pv-pago-titulo">' + escapeHtml(pago.tipo) + ' — ' + fmtMoneda(pago.monto, moneda) + '</span>' +
          '<span class="pv-badge pv-badge--' + badgeClass + '">' + escapeHtml(PAGO_ESTADO_LABEL[pago.estado] || pago.estado) + '</span>' +
        '</div>' +
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
})();
