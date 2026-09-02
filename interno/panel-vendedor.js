/*
 * Panel del Vendedor — RIO-117 (primer bloque, 31/08/2026).
 *
 * Consume exclusivamente las APIs ya construidas en RIO-112 a RIO-116 —
 * nunca reimplementa una regla de permisos, un porcentaje, una moneda o
 * un estado: todo lo que se muestra viene ya resuelto por el servidor. El
 * acceso al panel depende de tener una identidad resuelta por whoami
 * (cualquier rol con relación a alguna venta propia — admin, supervisor
 * o asistente con capacidad de vender también ven sus propias ventas
 * acá, nunca solo "ejecutivo").
 *
 * Alcance de este primer bloque: Mis ventas (lista + filtros + detalle
 * de proyecto/componentes/pagos/comprobantes/historial) y Mis comisiones
 * (vista agregada, separada por moneda y por estado, con motivo de
 * retención/reprogramación y enlace a la liquidación cuando corresponde).
 * Queda documentado como pendiente para el próximo bloque: refinar el
 * filtro de período, una bandeja de notificaciones (hoy exclusiva de
 * admin, sin uso para el vendedor), y una auditoría de accesibilidad más
 * profunda.
 */

(function () {
  'use strict';

  var identity = null;
  var misVentas = [];
  var comisionesCache = {}; // ventaId -> comisiones[] (de esta venta, ya resueltas por el servidor)
  var liquidacionMap = null; // comisionId -> { liquidacionId, conversionId } — se arma una sola vez, bajo demanda.
  var detalleVentaCache = {}; // ventaId -> { venta, cliente, proyecto, componentes, pagosEsperados }

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
  // RIO-118 (corrección funcional — materiales por correo central,
  // 01/09/2026): estado de revisión de CADA entrega — independiente del
  // estado oficial del componente (MATERIALES_ESTADO de arriba).
  var ESTADO_REVISION_LABEL = {
    informada: 'Informada', en_revision: 'En revisión', aceptada: 'Aceptada',
    requiere_material_adicional: 'Requiere material adicional', descartada_con_motivo: 'Descartada',
  };
  var ESTADO_REVISION_BADGE = {
    informada: 'neutral', en_revision: 'blue', aceptada: 'green',
    requiere_material_adicional: 'amber', descartada_con_motivo: 'red',
  };
  var CORREO_MATERIALES = 'venta@rioimpulsodigital.com';
  var ELEMENTOS_MATERIALES = [
    ['logo', 'Logo'], ['fotos', 'Fotos'], ['textos', 'Textos'], ['otros', 'Otros'],
  ];
  // RIO-117 (segundo bloque): "estado operativo" es el que ya calcula el
  // backend a partir de hechos reales (pago acreditado, cancelación) —
  // nunca una transición nueva. Incluye los dos casos que proyectoEstado
  // solo no puede distinguir: recién cerrada sin pago, y cancelada.
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
  var TIPO_COMISION_LABEL = { comercial: 'Comercial', supervision: 'Supervisión', realizacion: 'Realización', desarrollo: 'Desarrollo' };
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
    try { body = await response.json(); } catch (e) { /* respuestas de archivo no son JSON — no aplica acá */ }
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
    if (!identity) {
      document.getElementById('pvBlocked').style.display = 'block';
      document.getElementById('pvGreeting').textContent = 'No se pudo verificar tu identidad.';
      return;
    }
    document.getElementById('pvGreeting').textContent =
      identity.nombre + ', acá ves únicamente tus propias ventas y comisiones — nunca las de otra persona.';
    document.getElementById('pvApp').style.display = 'block';

    wireTabs();
    wireFilters();
    wireDetailPanel();
    await cargarMisVentas();
    await cargarReferentes();
  });

  // ── Mi referente comercial (RIO-118, corrección 01/09/2026) ─────────
  // Resuelto 100% server-side, sin ningún parámetro — nunca se arma con
  // datos del cliente ni con un archivo estático del frontend.

  function normalizarWhatsAppHref(numero) {
    var soloDigitos = String(numero || '').replace(/[^\d]/g, '');
    return 'https://wa.me/' + soloDigitos;
  }

  function renderReferenteCardHTML(ref) {
    var metaHTML = '<div class="pv-referente-meta">' + escapeHtml(ref.equipoNombre || '—') + ' · ' + escapeHtml(ref.mercado || '—') + '</div>';

    if (ref.esUnoMismo) {
      return (
        '<div class="pv-referente-card">' +
          '<div class="pv-referente-info">' +
            '<p class="pv-referente-titulo">Mi referente comercial</p>' +
            '<p class="pv-referente-uno-mismo">Sos el supervisor asignado de este equipo.</p>' +
            metaHTML +
          '</div>' +
        '</div>'
      );
    }

    if (ref.disponibilidad === 'sin_supervisor') {
      return (
        '<div class="pv-referente-card">' +
          '<div class="pv-referente-info">' +
            '<p class="pv-referente-titulo">Mi referente comercial</p>' +
            '<p class="pv-referente-pendiente">Sin supervisor asignado — contactar a Administración.</p>' +
            metaHTML +
          '</div>' +
        '</div>'
      );
    }

    var nombreMostrado = ref.supervisorNombre || 'Usuario sin nombre configurado';

    if (ref.disponibilidad === 'pendiente') {
      return (
        '<div class="pv-referente-card">' +
          '<div class="pv-referente-info">' +
            '<p class="pv-referente-titulo">Mi referente comercial</p>' +
            '<p class="pv-referente-nombre">' + escapeHtml(nombreMostrado) + '</p>' +
            metaHTML +
            '<p class="pv-referente-pendiente">WhatsApp laboral pendiente de configuración.</p>' +
          '</div>' +
        '</div>'
      );
    }

    // disponibilidad === 'configurado'
    return (
      '<div class="pv-referente-card">' +
        '<div class="pv-referente-info">' +
          '<p class="pv-referente-titulo">Mi referente comercial</p>' +
          '<p class="pv-referente-nombre">' + escapeHtml(nombreMostrado) + '</p>' +
          metaHTML +
          '<p class="pv-referente-whatsapp-label">WhatsApp laboral visible para mi equipo</p>' +
        '</div>' +
        '<a class="pv-referente-btn" href="' + escapeHtml(normalizarWhatsAppHref(ref.whatsappLaboral)) + '" target="_blank" rel="noopener noreferrer">Escribir por WhatsApp</a>' +
      '</div>'
    );
  }

  async function cargarReferentes() {
    var contenedor = document.getElementById('pvReferentes');
    var r = await apiFetch('/interno/api/identidad/referente');
    if (!r.ok || !r.body || !r.body.ok || !r.body.data.referentes || r.body.data.referentes.length === 0) {
      contenedor.innerHTML = '';
      return;
    }
    contenedor.innerHTML = '<div class="pv-referentes">' + r.body.data.referentes.map(renderReferenteCardHTML).join('') + '</div>';
  }

  function wireTabs() {
    var btnVentas = document.getElementById('pvTabVentasBtn');
    var btnComisiones = document.getElementById('pvTabComisionesBtn');
    btnVentas.addEventListener('click', function () { activarTab('ventas'); });
    btnComisiones.addEventListener('click', function () {
      activarTab('comisiones');
      if (!comisionesYaCargadas) cargarMisComisiones();
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

  // ── Mis ventas ─────────────────────────────────────────────────────

  async function cargarMisVentas() {
    var r = await apiFetch('/interno/api/ventas');
    if (!r.ok || !r.body || !r.body.ok) {
      document.getElementById('pvVentasResult').innerHTML = pvErrorHTML('No se pudieron cargar tus ventas. Recargá la página.');
      return;
    }
    // El servidor ya autoriza esta lista (propias, o todo el mercado si sos
    // admin/supervisor) — acá solo se filtra a lo que es efectivamente
    // "mío" para esta vista, nunca se relaja ni se amplía un permiso.
    misVentas = (r.body.data.ventas || []).filter(function (v) { return v.vendedorEmail === identity.email; });
    renderVentas();
  }

  function wireFilters() {
    ['fCliente', 'fMercado', 'fProducto', 'fEstado', 'fPago', 'fMateriales', 'fDesde', 'fHasta'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', renderVentas);
      document.getElementById(id).addEventListener('change', renderVentas);
    });
    document.getElementById('pvClearFilters').addEventListener('click', function () {
      ['fCliente', 'fMercado', 'fProducto', 'fEstado', 'fPago', 'fMateriales', 'fDesde', 'fHasta'].forEach(function (id) { document.getElementById(id).value = ''; });
      renderVentas();
    });
    ['fcMercado', 'fcEstado', 'fcTipo'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', renderComisiones);
    });
    document.getElementById('pvClearFiltersComisiones').addEventListener('click', function () {
      ['fcMercado', 'fcEstado', 'fcTipo'].forEach(function (id) { document.getElementById(id).value = ''; });
      renderComisiones();
    });
  }

  function ventasFiltradas() {
    var cliente = document.getElementById('fCliente').value.trim().toLowerCase();
    var mercado = document.getElementById('fMercado').value;
    var producto = document.getElementById('fProducto').value;
    var estado = document.getElementById('fEstado').value;
    var pago = document.getElementById('fPago').value;
    var materiales = document.getElementById('fMateriales').value;
    var desde = document.getElementById('fDesde').value;
    var hasta = document.getElementById('fHasta').value;
    return misVentas.filter(function (v) {
      if (cliente && (!v.cliente || !v.cliente.negocio || v.cliente.negocio.toLowerCase().indexOf(cliente) === -1)) return false;
      if (mercado && v.mercado !== mercado) return false;
      if (producto && v.producto !== producto) return false;
      if (estado && v.estadoOperativo !== estado) return false;
      if (pago && v.estadoPagoResumen !== pago) return false;
      if (materiales && v.estadoMaterialesResumen !== materiales) return false;
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
      el.innerHTML = pvEmptyHTML('🗂️', 'Todavía no tenés ninguna venta registrada.');
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
          '<td>' + escapeHtml(PRODUCTO_LABEL[v.producto] || v.producto) + '<br><span class="pv-badge pv-badge--neutral">' + escapeHtml(v.mercado) + '</span></td>' +
          '<td>' + fmtMoneda(v.precioPactado, v.moneda) + '</td>' +
          '<td><span class="pv-badge pv-badge--' + (ESTADO_OPERATIVO_BADGE[v.estadoOperativo] || 'neutral') + '">' + escapeHtml(ESTADO_OPERATIVO_LABEL[v.estadoOperativo] || v.estadoOperativo || '—') + '</span></td>' +
          '<td>' + fmtFecha(v.createdAt) + '</td>' +
        '</tr>'
      );
    }).join('');
    el.innerHTML =
      '<div class="pv-table-wrap"><table class="pv-table">' +
        '<thead><tr><th>Cliente</th><th>Producto</th><th>Precio</th><th>Estado</th><th>Fecha</th></tr></thead>' +
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

  // ── Detalle de venta ──────────────────────────────────────────────

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
    wireDetalleVentaEventos(detalle);
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

  // RIO-118 (corrección funcional — materiales por correo central,
  // 01/09/2026): el cliente entrega al ejecutivo, que reenvía por correo
  // a venta@rioimpulsodigital.com — el Portal NUNCA almacena los
  // archivos, solo el hecho de la entrega y su revisión. Por eso este
  // asunto es solo texto para copiar y pegar en el correo, nunca un
  // envío automático ni un control de subida.
  function siguienteNumeroEntrega(c) {
    return ((c.materialesInformes || []).length) + 1;
  }

  function construirAsuntoSugerido(detalle, c) {
    var tipo = c.tipo === 'ficha' ? 'FICHA' : 'LANDING';
    return '[MATERIALES] [' + detalle.venta.codigoVenta + '] [' + detalle.cliente.negocio + '] [' + tipo + '] [ENTREGA ' + siguienteNumeroEntrega(c) + '°]';
  }

  function renderMaterialesHTML(detalle, c) {
    var esVendedor = detalle.venta.vendedorEmail === identity.email;
    var badge = MATERIALES_ESTADO_BADGE[c.materialesEstado] || 'neutral';
    var html = '<div class="pv-materiales-box">' +
      '<div class="pv-materiales-head">' +
        '<span class="pv-materiales-titulo">Materiales</span>' +
        '<span class="pv-badge pv-badge--' + badge + '">' + escapeHtml(MATERIALES_ESTADO_LABEL[c.materialesEstado] || c.materialesEstado) + '</span>' +
      '</div>' +
      '<p class="pv-materiales-correo-nota">El cliente entrega los materiales al ejecutivo, que los reenvía por correo a <strong>' + CORREO_MATERIALES + '</strong> — el Portal registra el hecho de la entrega, nunca los archivos.</p>';

    // Cronológico: la entrega más reciente primero (el servidor ya la
    // ordena así), pero el número de entrega identifica el orden real.
    (c.materialesInformes || []).forEach(function (i) {
      var badgeRevision = ESTADO_REVISION_BADGE[i.estadoRevision] || 'neutral';
      html += '<div class="pv-materiales-informe">' +
        '<div class="pv-materiales-informe-head">' +
          '<strong>Entrega N.º ' + i.numeroEntrega + '</strong>' +
          '<span class="pv-badge pv-badge--' + badgeRevision + '">' + escapeHtml(ESTADO_REVISION_LABEL[i.estadoRevision] || i.estadoRevision) + '</span>' +
        '</div>' +
        escapeHtml(i.informadoPorNombre || 'Usuario sin nombre configurado') + ' · ' + fmtFecha(i.createdAt) +
        (i.elementos && i.elementos.length ? ' — ' + i.elementos.map(escapeHtml).join(', ') : '') +
        (i.cantidadArchivosAprox ? ' · ≈' + i.cantidadArchivosAprox + ' archivo(s)' : '') +
        '<br>' + escapeHtml(i.descripcion || '—') +
        (i.observaciones ? '<br><em>"' + escapeHtml(i.observaciones) + '"</em>' : '') +
        (i.motivoRevision ? '<div class="pv-materiales-motivo-admin">Administración: ' + escapeHtml(i.motivoRevision) + '</div>' : '') +
      '</div>';
    });
    if (!c.materialesInformes || c.materialesInformes.length === 0) {
      html += '<p class="pv-materiales-vacio">Todavía no se informó ninguna entrega.</p>';
    }

    if (c.costoDominioPendiente) {
      html += '<div class="pv-dominio-pendiente">El costo del dominio propio todavía no fue confirmado por administración — mientras tanto, la comisión de esta venta queda estimada, no definitiva.</div>';
    }

    // RIO-118: el botón queda SIEMPRE disponible — "Materiales completos"
    // nunca lo oculta ni cierra el registro (Brenda: "la posibilidad de
    // informar materiales debe permanecer siempre abierta").
    if (esVendedor) {
      var asunto = construirAsuntoSugerido(detalle, c);
      html += '<div class="pv-materiales-asunto">' +
        '<span class="pv-materiales-asunto-label">Asunto sugerido para el correo:</span>' +
        '<code class="pv-materiales-asunto-texto" data-asunto-texto>' + escapeHtml(asunto) + '</code>' +
        '<button type="button" class="pv-btn" data-copiar-asunto="' + escapeHtml(asunto) + '">Copiar asunto</button>' +
      '</div>' +
      '<form class="pv-materiales-form" data-informar-materiales="' + escapeHtml(c.id) + '">' +
        '<div class="pv-materiales-checks">' +
          ELEMENTOS_MATERIALES.map(function (e) {
            return '<label><input type="checkbox" value="' + escapeHtml(e[0]) + '"> ' + escapeHtml(e[1]) + '</label>';
          }).join('') +
        '</div>' +
        '<textarea class="pv-materiales-descripcion" placeholder="Descripción del material enviado (obligatorio) — qué es, qué contiene…" required></textarea>' +
        '<input type="number" min="0" step="1" class="pv-materiales-cantidad" placeholder="Cantidad aproximada de archivos (opcional)">' +
        '<textarea class="pv-materiales-observaciones" placeholder="Observación opcional"></textarea>' +
        '<button type="submit" class="pv-btn pv-btn--primary">Informar nuevos materiales</button>' +
      '</form>';
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
          renderMaterialesHTML(detalle, c) +
        '</div>'
      );
    }).join('');

    var pagosHTML = await Promise.all(detalle.pagosEsperados.map(function (p) { return renderPagoHTML(detalle.venta.id, p, detalle.venta.moneda); }));

    var historialHTML = await renderHistorialHTML(detalle.venta.id);
    var antecedentesHTML = renderAntecedentesHTML(detalle);

    return (
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Venta</p>' +
        '<dl class="pv-kv">' +
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
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Pagos</p>' + pagosHTML.join('') + '</div>' +
      '<div class="pv-detail-section"><p class="pv-detail-section-title">Avance y próximo paso</p>' + historialHTML + '</div>' +
      (antecedentesHTML ? '<div class="pv-detail-section">' + antecedentesHTML + '</div>' : '')
    );
  }

  async function renderPagoHTML(ventaId, pago, moneda) {
    var badgeClass = pago.estado === 'acreditado' ? 'green' : (pago.estado === 'informado' ? 'blue' : 'neutral');
    var comprobanteHTML = '';
    var accionesHTML = '';

    if (pago.estado === 'pendiente') {
      accionesHTML =
        '<form class="pv-informar-form" data-informar-pago="' + escapeHtml(pago.id) + '">' +
          '<input type="number" min="1" step="1" placeholder="Monto informado" required aria-label="Monto informado para este pago">' +
          '<button type="submit" class="pv-btn pv-btn--primary">Informar pago</button>' +
        '</form>';
    } else {
      var r = await apiFetch('/interno/api/ventas/' + encodeURIComponent(ventaId) + '/pagos/' + encodeURIComponent(pago.id) + '/comprobante');
      var comprobante = (r.ok && r.body && r.body.ok) ? r.body.data.comprobante : null;
      if (comprobante && comprobante.rechazadoEn) {
        comprobanteHTML = '<div class="pv-motivo-box"><strong>Comprobante rechazado.</strong> Motivo: ' + escapeHtml(comprobante.motivoRechazo) +
          '<br>Subí una versión nueva para corregirlo.</div>';
      } else if (comprobante) {
        comprobanteHTML = '<div class="pv-comprobante-info">Comprobante subido (versión ' + comprobante.version + ') — ' + escapeHtml(comprobante.nombreOriginal) + '</div>';
      }
      accionesHTML =
        '<div class="pv-upload-row">' +
          '<form data-subir-comprobante="' + escapeHtml(pago.id) + '">' +
            '<input type="file" accept=".pdf,.jpg,.jpeg,.png" aria-label="Subir comprobante de este pago">' +
            '<button type="submit" class="pv-btn" style="margin-top:6px;">' + (comprobante ? 'Subir corrección (nueva versión)' : 'Subir comprobante') + '</button>' +
          '</form>' +
          '<p class="pv-upload-hint">Solo PDF, JPG o PNG — hasta 10 MB. Se valida también en el servidor.</p>' +
        '</div>';
    }

    return (
      '<div class="pv-pago-card">' +
        '<div class="pv-pago-head">' +
          '<span class="pv-pago-titulo">' + escapeHtml(pago.tipo) + ' — ' + fmtMoneda(pago.monto, moneda) + '</span>' +
          '<span class="pv-badge pv-badge--' + badgeClass + '">' + escapeHtml(PAGO_ESTADO_LABEL[pago.estado] || pago.estado) + '</span>' +
        '</div>' +
        comprobanteHTML + accionesHTML +
      '</div>'
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

  function wireDetalleVentaEventos(detalle) {
    var body = document.getElementById('pvDetailBody');

    Array.prototype.forEach.call(body.querySelectorAll('form[data-informar-pago]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pagoId = form.getAttribute('data-informar-pago');
        var monto = Number(form.querySelector('input[type="number"]').value);
        var btn = form.querySelector('button');
        btn.disabled = true; btn.textContent = 'Informando…';
        var r = await apiFetch(
          '/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/pagos/' + encodeURIComponent(pagoId),
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'informar', montoInformado: monto }) }
        );
        if (!r.ok) {
          btn.disabled = false; btn.textContent = 'Informar pago';
          alert((r.body && r.body.error && r.body.error.message) || 'No se pudo informar el pago.');
          return;
        }
        delete detalleVentaCache[detalle.venta.id];
        abrirDetalleVenta(detalle.venta.id);
      });
    });

    Array.prototype.forEach.call(body.querySelectorAll('button[data-copiar-asunto]'), function (btn) {
      btn.addEventListener('click', async function () {
        var texto = btn.getAttribute('data-copiar-asunto');
        var original = btn.textContent;
        try {
          await navigator.clipboard.writeText(texto);
          btn.textContent = '¡Copiado!';
        } catch (e) {
          btn.textContent = 'No se pudo copiar';
        }
        setTimeout(function () { btn.textContent = original; }, 1800);
      });
    });

    Array.prototype.forEach.call(body.querySelectorAll('form[data-informar-materiales]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var componenteId = form.getAttribute('data-informar-materiales');
        var elementos = Array.prototype.map.call(form.querySelectorAll('input[type="checkbox"]:checked'), function (cb) { return cb.value; });
        var descripcion = form.querySelector('.pv-materiales-descripcion').value.trim();
        if (!descripcion) { alert('⚠️ Falta describir el material enviado.'); return; }
        var cantidadInput = form.querySelector('.pv-materiales-cantidad').value;
        var cantidadArchivosAprox = cantidadInput ? parseInt(cantidadInput, 10) : undefined;
        var observaciones = form.querySelector('.pv-materiales-observaciones').value.trim() || null;
        var btn = form.querySelector('button[type="submit"]');
        var textoOriginal = btn.textContent;
        btn.disabled = true; btn.textContent = 'Informando…';
        var r = await apiFetch(
          '/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/componentes/' + encodeURIComponent(componenteId),
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'materiales-informados', elementos: elementos, descripcion: descripcion, cantidadArchivosAprox: cantidadArchivosAprox, observaciones: observaciones }) }
        );
        if (!r.ok) {
          btn.disabled = false; btn.textContent = textoOriginal;
          alert((r.body && r.body.error && r.body.error.message) || 'No se pudo informar los materiales.');
          return;
        }
        delete detalleVentaCache[detalle.venta.id];
        abrirDetalleVenta(detalle.venta.id);
      });
    });

    Array.prototype.forEach.call(body.querySelectorAll('form[data-subir-comprobante]'), function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var pagoId = form.getAttribute('data-subir-comprobante');
        var input = form.querySelector('input[type="file"]');
        var archivo = input.files[0];
        if (!archivo) { alert('Elegí un archivo primero.'); return; }
        // Validación en el CLIENTE — solo para mejorar la experiencia (evitar
        // una subida que ya se sabe que va a fallar); la validación real
        // (extensión + MIME + firma real de los bytes) siempre se repite en
        // el servidor, nunca se confía en esto.
        var extension = (archivo.name.split('.').pop() || '').toLowerCase();
        if (['pdf', 'jpg', 'jpeg', 'png'].indexOf(extension) === -1) {
          alert('Solo se aceptan PDF, JPG o PNG.'); return;
        }
        if (archivo.size > 10 * 1024 * 1024) { alert('El archivo supera el límite de 10 MB.'); return; }

        var btn = form.querySelector('button');
        btn.disabled = true; btn.textContent = 'Subiendo…';
        var fd = new FormData();
        fd.append('archivo', archivo);
        var r = await apiFetch(
          '/interno/api/ventas/' + encodeURIComponent(detalle.venta.id) + '/pagos/' + encodeURIComponent(pagoId) + '/comprobante',
          { method: 'POST', body: fd }
        );
        if (!r.ok) {
          btn.disabled = false; btn.textContent = 'Subir comprobante';
          alert((r.body && r.body.error && r.body.error.message) || 'No se pudo subir el comprobante.');
          return;
        }
        abrirDetalleVenta(detalle.venta.id);
      });
    });
  }

  // ── Mis comisiones ─────────────────────────────────────────────────

  var comisionesYaCargadas = false;
  var todasMisComisiones = []; // { ...comision, ventaId, cliente, producto, mercado }

  async function cargarMisComisiones() {
    document.getElementById('pvComisionesResult').innerHTML = '<div class="pv-loading">Cargando tus comisiones…</div>';
    var lista = [];
    for (var i = 0; i < misVentas.length; i++) {
      var v = misVentas[i];
      var comisiones = await obtenerComisionesDeVenta(v.id);
      comisiones
        .filter(function (c) { return c.beneficiarioEmail === identity.email; })
        .forEach(function (c) {
          lista.push(Object.assign({}, c, { ventaId: v.id, cliente: v.cliente, producto: v.producto, mercado: v.mercado, codigoVenta: v.codigoVenta }));
        });
    }
    // No es únicamente lo que devuelve /ventas (mis ventas como VENDEDOR) —
    // una persona puede además cobrar realización sobre una venta ajena
    // (ej. un practicante que hizo el trabajo de una venta de otro
    // ejecutivo). Se completa con /comisiones/liquidaciones (ya filtra a
    // "las mías" del lado del servidor) para no perder esas filas.
    todasMisComisiones = lista;
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
    var mercado = document.getElementById('fcMercado').value;
    var estado = document.getElementById('fcEstado').value;
    var tipo = document.getElementById('fcTipo').value;
    return todasMisComisiones.filter(function (c) {
      if (mercado && c.mercado !== mercado) return false;
      if (estado && c.estado !== estado) return false;
      if (tipo && c.tipo !== tipo) return false;
      return true;
    });
  }

  function renderComisiones() {
    var el = document.getElementById('pvComisionesResult');
    if (!comisionesYaCargadas) return;
    if (todasMisComisiones.length === 0) {
      el.innerHTML = pvEmptyHTML('💰', 'Todavía no tenés ninguna comisión generada.');
      return;
    }
    var lista = comisionesFiltradas();
    if (lista.length === 0) {
      el.innerHTML = pvEmptyHTML('🔍', 'Ninguna comisión coincide con estos filtros.');
      return;
    }

    // Nunca se mezclan monedas: un bloque completo por moneda, cada uno con
    // sus propios totales por estado — jamás un total único que sume CLP y
    // ARS, ni un total que mezcle estimado con pagado.
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
            '<thead><tr><th>Cliente / Venta</th><th>Tipo</th><th>Base</th><th>Monto</th><th>Estado</th><th>Fechas</th></tr></thead>' +
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
    // RIO-117 (corrección tras validación real): en Landing Premium, el
    // precio atribuido al componente no es la utilidad neta — mientras el
    // costo real del dominio no se confirme, la comisión no puede quedar
    // definitiva. Esto nunca reemplaza el estado real (sigue "Estimada"),
    // solo explica por qué sigue así en vez de avanzar.
    var dominioHTML = (c.costoDominioPendiente && c.estado === 'calculada_provisional')
      ? '<div class="pv-comision-row-detail" style="color:var(--pv-amber);">Costo de dominio propio todavía sin confirmar por administración.</div>'
      : '';
    var fechasHTML =
      (c.fechaProgramadaOriginal ? 'Programada (original): ' + escapeHtml(c.fechaProgramadaOriginal) + '<br>' : '') +
      (c.fechaProgramadaEfectiva && c.fechaProgramadaEfectiva !== c.fechaProgramadaOriginal ? 'Programada (efectiva): ' + escapeHtml(c.fechaProgramadaEfectiva) + '<br>' : '') +
      (c.fechaPagoReal ? 'Pago real: ' + fmtFecha(c.fechaPagoReal) : '');
    var liqBtn = c.estado === 'pagada'
      ? '<button type="button" class="pv-comision-liq-btn" data-ver-liquidacion="' + escapeHtml(c.id) + '">Ver liquidación</button><div class="pv-liq-info" data-liq-info="' + escapeHtml(c.id) + '"></div>'
      : '';

    return (
      '<tr>' +
        '<td><span class="pv-cliente-nombre">' + escapeHtml(c.cliente && c.cliente.negocio || '—') + '</span><br>' +
          '<span class="pv-mono">' + escapeHtml(c.codigoVenta) + '</span>' +
          (c.componenteId ? '<div class="pv-comision-row-detail">Componente: ' + escapeHtml(c.componenteId) + '</div>' : '') +
        '</td>' +
        '<td>' + escapeHtml(TIPO_COMISION_LABEL[c.tipo] || c.tipo) + '</td>' +
        '<td>' + (c.porcentaje != null ? c.porcentaje + '% de ' + fmtMoneda(c.montoBase, c.moneda) : '—') + '</td>' +
        '<td>' + fmtMoneda(c.montoComision, c.moneda) + '</td>' +
        '<td><span class="pv-badge pv-badge--' + badge + '">' + escapeHtml(COMISION_ESTADO_LABEL[c.estado] || c.estado) + '</span>' + motivoHTML + dominioHTML + liqBtn + '</td>' +
        '<td class="pv-comision-row-detail">' + (fechasHTML || '—') + '</td>' +
      '</tr>'
    );
  }

  document.addEventListener('click', async function (e) {
    var btn = e.target.closest && e.target.closest('[data-ver-liquidacion]');
    if (!btn) return;
    var comisionId = btn.getAttribute('data-ver-liquidacion');
    var info = document.querySelector('[data-liq-info="' + comisionId + '"]');
    if (!info) return;
    info.textContent = 'Buscando…';
    var resultado = await buscarLiquidacionDeComision(comisionId);
    if (!resultado) { info.textContent = 'No se encontró una liquidación asociada.'; return; }

    var estadoDoc = await apiFetch('/interno/api/comisiones/liquidaciones/' + encodeURIComponent(resultado.liquidacionId) + '/estado-documental');
    var estadoTexto = (estadoDoc.ok && estadoDoc.body && estadoDoc.body.ok) ? estadoDoc.body.data.estadoDocumental : 'desconocido';

    // Los metadatos de cada comprobante traen su propio id, que es lo que
    // hace falta para armar el link real de descarga (.../archivo) — nunca
    // se arma esa ruta a mano con datos que no vinieron del servidor.
    var transferenciaMeta = await apiFetch('/interno/api/comisiones/liquidaciones/' + encodeURIComponent(resultado.liquidacionId) + '/comprobante-transferencia');
    var transferenciaComprobante = (transferenciaMeta.ok && transferenciaMeta.body && transferenciaMeta.body.ok) ? transferenciaMeta.body.data.comprobante : null;
    var transferenciaHTML = transferenciaComprobante
      ? '<br><a href="/interno/api/comisiones/liquidaciones/' + encodeURIComponent(resultado.liquidacionId) + '/comprobante-transferencia/' + encodeURIComponent(transferenciaComprobante.id) + '/archivo" target="_blank" rel="noopener">Descargar comprobante de transferencia</a>'
      : '<br>Comprobante de transferencia: todavía no subido.';

    var conversionHTML = '';
    if (resultado.conversionId) {
      var conversionMeta = await apiFetch('/interno/api/comisiones/conversiones/' + encodeURIComponent(resultado.conversionId) + '/comprobante');
      var conversionComprobante = (conversionMeta.ok && conversionMeta.body && conversionMeta.body.ok) ? conversionMeta.body.data.comprobante : null;
      conversionHTML = conversionComprobante
        ? '<br><a href="/interno/api/comisiones/conversiones/' + encodeURIComponent(resultado.conversionId) + '/comprobante/' + encodeURIComponent(conversionComprobante.id) + '/archivo" target="_blank" rel="noopener">Descargar comprobante de conversión</a>'
        : '<br>Comprobante de conversión: todavía no subido.';
    }

    info.innerHTML = '<div class="pv-comision-row-detail">Documentación: <strong>' + escapeHtml(estadoTexto) + '</strong>' + transferenciaHTML + conversionHTML + '</div>';
  });

  async function buscarLiquidacionDeComision(comisionId) {
    if (!liquidacionMap) {
      liquidacionMap = {};
      var r = await apiFetch('/interno/api/comisiones/liquidaciones');
      var liquidaciones = (r.ok && r.body && r.body.ok) ? r.body.data.liquidaciones : [];
      for (var i = 0; i < liquidaciones.length; i++) {
        var det = await apiFetch('/interno/api/comisiones/liquidaciones/' + encodeURIComponent(liquidaciones[i].id));
        if (!det.ok || !det.body || !det.body.ok) continue;
        det.body.data.detalle.forEach(function (d) {
          liquidacionMap[d.comisionId] = { liquidacionId: liquidaciones[i].id, conversionId: d.conversionId };
        });
      }
    }
    return liquidacionMap[comisionId] || null;
  }
})();
