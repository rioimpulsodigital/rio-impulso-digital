/*
 * Panel del Supervisor — RIO-118 (01/09/2026).
 *
 * Exclusivamente de LECTURA: no hay ningún formulario de acción en este
 * archivo (nunca informar pago, nunca subir comprobante, nunca informar
 * materiales) — un supervisor consulta el pipeline de su equipo, nunca lo
 * modifica. Reutiliza las mismas APIs de RIO-112 a RIO-117, ya scopeadas
 * server-side para este rol: GET /ventas devuelve las ventas de sus
 * mercados autorizados (nunca "todas" sin condición); GET /ventas/:id/
 * comisiones devuelve su propia comisión de cualquier tipo MÁS la
 * comercial del equipo del que es supervisor vigente — nunca realización,
 * desarrollo ni empresa ajenas (RIO-115); GET /ventas/:id redacta la
 * categoría "facturación" de los antecedentes del Kit y
 * cliente.datosFacturacionAr para cualquiera que no sea el vendedor dueño
 * o admin (RIO-117). Los comprobantes bancarios de liquidaciones/
 * conversiones ajenas están cerrados desde RIO-116 ("ser supervisor de la
 * persona beneficiaria no concede acceso al comprobante") — este panel no
 * intenta acceder a ellos.
 */

(function () {
  'use strict';

  var identity = null;
  var misVentas = []; // todas las ventas visibles (propias + supervisadas), ya scopeadas por el servidor.
  var comisionesCache = {};
  var detalleVentaCache = {};

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
  var COMISION_ESTADO_LABEL = {
    calculada_provisional: 'Estimada', retenida: 'Retenida', habilitada: 'Habilitada',
    programada: 'Programada', pagada: 'Pagada',
  };
  var COMISION_ESTADO_BADGE = {
    calculada_provisional: 'neutral', retenida: 'red', habilitada: 'amber', programada: 'blue', pagada: 'green',
  };
  var TIPO_COMISION_LABEL = { comercial: 'Comercial', supervision: 'Supervisión' };
  var GATE_FALTANTE_LABEL = {
    ficha_aprobada: 'La Ficha todavía no fue aprobada por administración.',
    segundo_pago_acreditado: 'El saldo (segundo pago) todavía no está acreditado.',
    materiales_landing_completos: 'Los materiales de la Landing todavía no están completos.',
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

  async function apiFetch(path, options) {
    var response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
    var body = null;
    try { body = await response.json(); } catch (e) { /* no aplica */ }
    return { ok: response.ok, status: response.status, body: body };
  }

  // ── Identidad y arranque ──────────────────────────────────────────

  async function whoami() {
    var r = await apiFetch('/interno/api/identidad/whoami');
    if (!r.ok || !r.body || !r.body.ok) return null;
    return r.body.data;
  }

  document.addEventListener('DOMContentLoaded', async function () {
    identity = await whoami();
    // Capacidad, nunca nombre de rol (mismo criterio que todo el sistema
    // desde RIO-111/113): admin y supervisor comparten viewOthersData.
    if (!identity || !identity.permissions || !identity.permissions.viewOthersData) {
      document.getElementById('pvBlocked').style.display = 'block';
      document.getElementById('pvGreeting').textContent = identity ? 'Tu cuenta no tiene capacidad de supervisión.' : 'No se pudo verificar tu identidad.';
      return;
    }
    document.getElementById('pvGreeting').textContent =
      identity.nombre + ', acá consultás las ventas y comisiones de tu equipo — de solo lectura, nada se modifica desde este panel.';
    document.getElementById('pvApp').style.display = 'block';

    wireTabs();
    wireFilters();
    wireDetailPanel();
    await cargarVentas();
  });

  function wireTabs() {
    var btnVentas = document.getElementById('pvTabVentasBtn');
    var btnComisiones = document.getElementById('pvTabComisionesBtn');
    btnVentas.addEventListener('click', function () { activarTab('ventas'); });
    btnComisiones.addEventListener('click', function () {
      activarTab('comisiones');
      if (!comisionesYaCargadas) cargarComisiones();
    });
  }

  function activarTab(nombre) {
    var esVentas = nombre === 'ventas';
    document.getElementById('pvTabVentasBtn').classList.toggle('active', esVentas);
    document.getElementById('pvTabVentasBtn').setAttribute('aria-selected', String(esVentas));
    document.getElementById('pvTabComisionesBtn').classList.toggle('active', !esVentas);
    document.getElementById('pvTabComisionesBtn').setAttribute('aria-selected', String(!esVentas));
    document.getElementById('pvTabVentas').classList.toggle('active', esVentas);
    document.getElementById('pvTabComisiones').classList.toggle('active', !esVentas);
  }

  // ── Ventas del equipo ──────────────────────────────────────────────

  async function cargarVentas() {
    var r = await apiFetch('/interno/api/ventas');
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvVentasResult').innerHTML = pvErrorHTML('No se pudieron cargar las ventas. Recargá la página.');
      return;
    }
    // El servidor ya scopea esto a los mercados autorizados del
    // supervisor — acá solo se distingue "propia" de "supervisada" para
    // mostrarlo, nunca se amplía ni se relaja ningún permiso.
    misVentas = r.body.data.ventas || [];
    poblarFiltroEjecutivo();
    renderPipeline();
    renderVentas();
  }

  function poblarFiltroEjecutivo() {
    var select = document.getElementById('fEjecutivo');
    var actual = select.value;
    var emails = Array.from(new Set(misVentas.map(function (v) { return v.vendedorEmail; }))).sort();
    select.innerHTML = '<option value="">Todos</option>' + emails.map(function (e) {
      return '<option value="' + escapeHtml(e) + '">' + escapeHtml(e) + '</option>';
    }).join('');
    select.value = actual;
  }

  function renderPipeline() {
    var counts = {};
    misVentas.forEach(function (v) { counts[v.estadoOperativo] = (counts[v.estadoOperativo] || 0) + 1; });
    var orden = ['en_espera_pago', 'registrado', 'en_produccion', 'completado', 'cancelada'];
    document.getElementById('pvPipeline').innerHTML = orden
      .filter(function (e) { return counts[e]; })
      .map(function (e) {
        return '<span class="pv-pipeline-chip">' + escapeHtml(ESTADO_OPERATIVO_LABEL[e]) + ': <strong>' + counts[e] + '</strong></span>';
      }).join('') || '<span class="pv-pipeline-chip">Sin ventas todavía en tus mercados.</span>';
  }

  function wireFilters() {
    ['fCliente', 'fEjecutivo', 'fOrigen', 'fMercado', 'fProducto', 'fEstado', 'fDesde', 'fHasta'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', renderVentas);
      document.getElementById(id).addEventListener('change', renderVentas);
    });
    document.getElementById('pvClearFilters').addEventListener('click', function () {
      ['fCliente', 'fEjecutivo', 'fOrigen', 'fMercado', 'fProducto', 'fEstado', 'fDesde', 'fHasta'].forEach(function (id) { document.getElementById(id).value = ''; });
      renderVentas();
    });
    ['fcOrigen', 'fcMercado', 'fcEstado'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', renderComisiones);
    });
    document.getElementById('pvClearFiltersComisiones').addEventListener('click', function () {
      ['fcOrigen', 'fcMercado', 'fcEstado'].forEach(function (id) { document.getElementById(id).value = ''; });
      renderComisiones();
    });
  }

  function ventasFiltradas() {
    var cliente = document.getElementById('fCliente').value.trim().toLowerCase();
    var ejecutivo = document.getElementById('fEjecutivo').value;
    var origen = document.getElementById('fOrigen').value;
    var mercado = document.getElementById('fMercado').value;
    var producto = document.getElementById('fProducto').value;
    var estado = document.getElementById('fEstado').value;
    var desde = document.getElementById('fDesde').value;
    var hasta = document.getElementById('fHasta').value;
    return misVentas.filter(function (v) {
      if (cliente && (!v.cliente || !v.cliente.negocio || v.cliente.negocio.toLowerCase().indexOf(cliente) === -1)) return false;
      if (ejecutivo && v.vendedorEmail !== ejecutivo) return false;
      var esPropia = v.vendedorEmail === identity.email;
      if (origen === 'propia' && !esPropia) return false;
      if (origen === 'supervisada' && esPropia) return false;
      if (mercado && v.mercado !== mercado) return false;
      if (producto && v.producto !== producto) return false;
      if (estado && v.estadoOperativo !== estado) return false;
      var fechaVenta = (v.createdAt || '').slice(0, 10);
      if (desde && fechaVenta < desde) return false;
      if (hasta && fechaVenta > hasta) return false;
      return true;
    });
  }

  function renderVentas() {
    var lista = ventasFiltradas();
    var el = document.getElementById('pvVentasResult');
    if (misVentas.length === 0) {
      el.innerHTML = pvEmptyHTML('🗂️', 'Todavía no hay ventas registradas en tus mercados.');
      return;
    }
    if (lista.length === 0) {
      el.innerHTML = pvEmptyHTML('🔍', 'Ninguna venta coincide con estos filtros.');
      return;
    }
    var rows = lista.map(function (v) {
      var esPropia = v.vendedorEmail === identity.email;
      return (
        '<tr tabindex="0" data-venta-id="' + escapeHtml(v.id) + '">' +
          '<td><span class="pv-cliente-nombre">' + escapeHtml(v.cliente && v.cliente.negocio || '—') + '</span><br>' +
            '<span class="pv-mono">' + escapeHtml(v.codigoVenta) + '</span></td>' +
          '<td>' + escapeHtml(v.vendedorEmail) + '<br><span class="pv-badge pv-badge--' + (esPropia ? 'purple' : 'neutral') + '">' + (esPropia ? 'Propia' : 'Supervisada') + '</span></td>' +
          '<td>' + escapeHtml(PRODUCTO_LABEL[v.producto] || v.producto) + '<br><span class="pv-badge pv-badge--neutral">' + escapeHtml(v.mercado) + '</span></td>' +
          '<td>' + fmtMoneda(v.precioPactado, v.moneda) + '</td>' +
          '<td><span class="pv-badge pv-badge--' + (ESTADO_OPERATIVO_BADGE[v.estadoOperativo] || 'neutral') + '">' + escapeHtml(ESTADO_OPERATIVO_LABEL[v.estadoOperativo] || v.estadoOperativo || '—') + '</span></td>' +
          '<td>' + fmtFecha(v.createdAt) + '</td>' +
        '</tr>'
      );
    }).join('');
    el.innerHTML =
      '<div class="pv-table-wrap"><table class="pv-table">' +
        '<thead><tr><th>Cliente</th><th>Ejecutivo</th><th>Producto</th><th>Precio</th><th>Estado</th><th>Fecha</th></tr></thead>' +
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

  // ── Detalle de venta (solo lectura) ─────────────────────────────────

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
  }

  async function abrirDetalleVenta(ventaId) {
    var overlay = document.getElementById('pvDetailOverlay');
    var panel = document.getElementById('pvDetail');
    overlay.classList.add('open');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.getElementById('pvDetailBody').innerHTML = '<div class="pv-loading">Cargando…</div>';

    var detalle = await obtenerDetalleVenta(ventaId);
    if (!detalle) {
      document.getElementById('pvDetailBody').innerHTML = pvErrorHTML('No se pudo cargar el detalle de esta venta.');
      return;
    }
    document.getElementById('pvDetailCodigo').textContent = detalle.venta.codigoVenta;
    document.getElementById('pvDetailNegocio').textContent = detalle.cliente.negocio;
    document.getElementById('pvDetailBody').innerHTML = await renderDetalleVentaHTML(detalle);
  }

  async function obtenerDetalleVenta(ventaId) {
    if (detalleVentaCache[ventaId]) return detalleVentaCache[ventaId];
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId));
    if (!r.ok || !r.body || !r.body.ok) return null;
    detalleVentaCache[ventaId] = r.body.data;
    return r.body.data;
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

  function renderMaterialesSoloLecturaHTML(c) {
    var badge = MATERIALES_ESTADO_BADGE[c.materialesEstado] || 'neutral';
    var html = '<div class="pv-materiales-box">' +
      '<div class="pv-materiales-head">' +
        '<span class="pv-materiales-titulo">Materiales</span>' +
        '<span class="pv-badge pv-badge--' + badge + '">' + escapeHtml(MATERIALES_ESTADO_LABEL[c.materialesEstado] || c.materialesEstado) + '</span>' +
      '</div>';
    (c.materialesInformes || []).slice(0, 2).forEach(function (i) {
      html += '<div class="pv-materiales-informe">Informado por <strong>' + escapeHtml(i.informadoPor) + '</strong> el ' + fmtFecha(i.createdAt) +
        (i.elementos && i.elementos.length ? ' — ' + i.elementos.map(escapeHtml).join(', ') : '') + '</div>';
    });
    (c.materialesConfirmaciones || []).slice(0, 1).forEach(function (cf) {
      html += '<div class="pv-materiales-informe">' + (cf.resultado === 'completos' ? '✓ Confirmado completo' : '✗ Confirmado incompleto') + ' por administración el ' + fmtFecha(cf.createdAt) + '</div>';
    });
    if (c.costoDominioPendiente) {
      html += '<div class="pv-dominio-pendiente">Costo del dominio propio todavía no confirmado por administración — la comisión de esta venta queda estimada.</div>';
    }
    html += '</div>';
    return html;
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
      '<details class="pv-antecedentes"><summary>Antecedentes del Kit</summary>' +
        '<div class="pv-antecedentes-body">' + bloques + '</div>' +
      '</details>'
    );
  }

  async function renderDetalleVentaHTML(detalle) {
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
          renderMaterialesSoloLecturaHTML(c) +
        '</div>'
      );
    }).join('');

    var pagosHTML = detalle.pagosEsperados.map(function (p) {
      var badgeClass = p.estado === 'acreditado' ? 'green' : (p.estado === 'informado' ? 'blue' : 'neutral');
      return (
        '<div class="pv-pago-card">' +
          '<div class="pv-pago-head">' +
            '<span class="pv-pago-titulo">' + escapeHtml(p.tipo) + ' — ' + fmtMoneda(p.monto, detalle.venta.moneda) + '</span>' +
            '<span class="pv-badge pv-badge--' + badgeClass + '">' + escapeHtml(PAGO_ESTADO_LABEL[p.estado] || p.estado) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    var historialHTML = await renderHistorialHTML(detalle.venta.id);
    var antecedentesHTML = renderAntecedentesHTML(detalle);

    return (
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Venta</p>' +
        '<dl class="pv-kv">' +
          '<dt>Ejecutivo</dt><dd>' + escapeHtml(detalle.venta.vendedorEmail) + '</dd>' +
          '<dt>Producto</dt><dd>' + escapeHtml(PRODUCTO_LABEL[detalle.venta.producto] || detalle.venta.producto) + '</dd>' +
          '<dt>Mercado</dt><dd>' + escapeHtml(detalle.venta.mercado) + '</dd>' +
          '<dt>Precio pactado</dt><dd>' + fmtMoneda(detalle.venta.precioPactado, detalle.venta.moneda) + '</dd>' +
          '<dt>Fecha</dt><dd>' + fmtFecha(detalle.venta.createdAt) + '</dd>' +
        '</dl>' +
      '</div>' +
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Cliente</p>' +
        '<dl class="pv-kv">' +
          '<dt>Negocio</dt><dd>' + escapeHtml(detalle.cliente.negocio) + '</dd>' +
          (detalle.cliente.contactoNombre ? '<dt>Contacto</dt><dd>' + escapeHtml(detalle.cliente.contactoNombre) + '</dd>' : '') +
          (detalle.cliente.telefono ? '<dt>Teléfono</dt><dd>' + escapeHtml(detalle.cliente.telefono) + '</dd>' : '') +
        '</dl>' +
      '</div>' +
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Proyecto y componentes</p>' + componentesHTML + '</div>' +
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Pagos</p>' + pagosHTML + '</div>' +
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Avance y próximo paso</p>' + historialHTML + '</div>' +
      (antecedentesHTML ? '<div class="pv-detail-section">' + antecedentesHTML + '</div>' : '')
    );
  }

  async function renderHistorialHTML(ventaId) {
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/historial');
    if (!r.ok || !r.body || !r.body.ok || !r.body.data.eventos || r.body.data.eventos.length === 0) {
      return '<p style="font-size:.82rem;color:var(--muted);">Todavía no hay eventos registrados.</p>';
    }
    var eventos = r.body.data.eventos;
    var ultimo = eventos[eventos.length - 1];
    var itemsHTML = eventos.slice(-8).reverse().map(function (e) {
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

  // ── Comisiones (mías + comercial de mi equipo) ──────────────────────

  var comisionesYaCargadas = false;
  var todasLasComisiones = []; // { ...comision, ventaId, cliente, producto, mercado, codigoVenta, origen: 'propia'|'equipo' }

  async function cargarComisiones() {
    document.getElementById('pvComisionesResult').innerHTML = '<div class="pv-loading">Cargando comisiones…</div>';
    var lista = [];
    for (var i = 0; i < misVentas.length; i++) {
      var v = misVentas[i];
      var comisiones = await obtenerComisionesDeVenta(v.id);
      comisiones.forEach(function (c) {
        // El servidor ya decide qué comisiones ve un supervisor sobre esta
        // venta (la suya de cualquier tipo, más la comercial del equipo) —
        // acá solo se etiqueta el origen para mostrarlo, nunca se filtra
        // de más ni se agrega nada que el servidor no haya devuelto.
        lista.push(Object.assign({}, c, {
          ventaId: v.id, cliente: v.cliente, producto: v.producto, mercado: v.mercado, codigoVenta: v.codigoVenta,
          origen: c.beneficiarioEmail === identity.email ? 'propia' : 'equipo',
        }));
      });
    }
    todasLasComisiones = lista;
    comisionesYaCargadas = true;
    renderComisiones();
  }

  async function obtenerComisionesDeVenta(ventaId) {
    if (comisionesCache[ventaId]) return comisionesCache[ventaId];
    var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/comisiones');
    var comisiones = (r.ok && r.body && r.body.ok) ? r.body.data.comisiones : [];
    comisionesCache[ventaId] = comisiones;
    return comisiones;
  }

  function comisionesFiltradas() {
    var origen = document.getElementById('fcOrigen').value;
    var mercado = document.getElementById('fcMercado').value;
    var estado = document.getElementById('fcEstado').value;
    return todasLasComisiones.filter(function (c) {
      if (origen && c.origen !== origen) return false;
      if (mercado && c.mercado !== mercado) return false;
      if (estado && c.estado !== estado) return false;
      return true;
    });
  }

  function renderComisiones() {
    var el = document.getElementById('pvComisionesResult');
    if (!comisionesYaCargadas) return;
    if (todasLasComisiones.length === 0) {
      el.innerHTML = pvEmptyHTML('💰', 'Todavía no hay comisiones para mostrar.');
      return;
    }
    var lista = comisionesFiltradas();
    if (lista.length === 0) {
      el.innerHTML = pvEmptyHTML('🔍', 'Ninguna comisión coincide con estos filtros.');
      return;
    }

    var monedas = {};
    lista.forEach(function (c) { (monedas[c.moneda] = monedas[c.moneda] || []).push(c); });

    var html = Object.keys(monedas).sort().map(function (moneda) {
      var filas = monedas[moneda];
      var totalesPorEstado = {};
      filas.forEach(function (c) { totalesPorEstado[c.estado] = (totalesPorEstado[c.estado] || 0) + (c.montoComision || 0); });
      var chipsHTML = Object.keys(totalesPorEstado).map(function (estado) {
        return '<span class="pv-total-chip">' + escapeHtml(COMISION_ESTADO_LABEL[estado] || estado) + ': <strong>' + fmtMoneda(totalesPorEstado[estado], moneda) + '</strong></span>';
      }).join('');

      var filasHTML = filas.map(renderFilaComisionHTML).join('');

      return (
        '<div class="pv-moneda-block">' +
          '<div class="pv-moneda-head"><span class="pv-moneda-titulo">' + escapeHtml(moneda) + '</span><div class="pv-moneda-totales">' + chipsHTML + '</div></div>' +
          '<div class="pv-table-wrap"><table class="pv-table">' +
            '<thead><tr><th>Cliente / Venta</th><th>Ejecutivo</th><th>Tipo</th><th>Origen</th><th>Monto</th><th>Estado</th></tr></thead>' +
            '<tbody>' + filasHTML + '</tbody>' +
          '</table></div>' +
        '</div>'
      );
    }).join('');

    el.innerHTML = html;
  }

  function renderFilaComisionHTML(c) {
    var badge = COMISION_ESTADO_BADGE[c.estado] || 'neutral';
    var motivoHTML = c.motivoRetencionOReprogramacion
      ? '<div class="pv-comision-row-detail" style="color:var(--pv-red);">Motivo: ' + escapeHtml(c.motivoRetencionOReprogramacion) + '</div>'
      : '';
    var dominioHTML = (c.costoDominioPendiente && c.estado === 'calculada_provisional')
      ? '<div class="pv-comision-row-detail" style="color:var(--pv-amber);">Costo de dominio propio todavía sin confirmar.</div>'
      : '';
    return (
      '<tr>' +
        '<td><span class="pv-cliente-nombre">' + escapeHtml(c.cliente && c.cliente.negocio || '—') + '</span><br>' +
          '<span class="pv-mono">' + escapeHtml(c.codigoVenta) + '</span></td>' +
        '<td>' + escapeHtml(c.beneficiarioEmail) + '</td>' +
        '<td>' + escapeHtml(TIPO_COMISION_LABEL[c.tipo] || c.tipo) + '</td>' +
        '<td><span class="pv-badge pv-badge--' + (c.origen === 'propia' ? 'purple' : 'neutral') + '">' + (c.origen === 'propia' ? 'Mía' : 'Equipo') + '</span></td>' +
        '<td>' + fmtMoneda(c.montoComision, c.moneda) + '</td>' +
        '<td><span class="pv-badge pv-badge--' + badge + '">' + escapeHtml(COMISION_ESTADO_LABEL[c.estado] || c.estado) + '</span>' + motivoHTML + dominioHTML + '</td>' +
      '</tr>'
    );
  }
})();
