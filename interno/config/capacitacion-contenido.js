/*
 * Contenido educativo de la Capacitación Ficha & Landing — Portal Interno RiO Impulso Digital.
 * RIO-95 (diseño) / RIO-96 (implementación).
 *
 * Todo lo que hay en este archivo es ficticio: negocios, nombres, teléfonos, direcciones,
 * reseñas y situaciones. No representa prospectos ni clientes reales.
 *
 * Este archivo NO contiene precios, monedas, fechas promocionales ni medios de pago —
 * eso se lee siempre en vivo desde config/markets.js (ver interno/capacitacion-ficha-landing.html).
 * No duplicar aquí nada que ya viva en markets.js o users.js.
 */

var TRAINING_CONTENT = {

  // ── Negocio protagonista (módulos 1-6) ──────────────────────────────
  protagonist: {
    name: 'Ferretería El Tornillo',
    category: 'Ferretería',
    rating: 4.6,
    reviewCount: 89,
    open: true,
    address: 'Av. Los Aromos 452 (zona centro)',
    hours: 'Lun a sáb, 9:00 a 19:00',
    phone: '+56 9 5555 1234',
    photos: 6,
    products: 'Herramientas manuales y eléctricas, pinturas, tornillería, artículos de gasfitería',
    reviewsSample: [
      { text: 'Encontré todo lo que buscaba y me asesoraron bien.', stars: 5 },
      { text: 'Buenos precios, atención rápida.', stars: 4 },
      { text: 'A veces no tienen stock de piezas más chicas.', stars: 3 }
    ],
    hasWebsite: false
  },

  // ── Resultados de la búsqueda simulada (módulo 1) ───────────────────
  searchResults: [
    { name: 'Ferretería El Tornillo', rating: 4.6, hasWebsite: false, protagonist: true },
    { name: 'Ferretería Don Pedro', rating: 4.2, hasWebsite: true },
    { name: 'Ferretería y Pinturas Sur', rating: 3.9, hasWebsite: false },
    { name: 'Multiservicio La Llave', rating: 4.8, hasWebsite: true }
  ],

  // ── Elementos de una Ficha de Google, con explicación (módulo 2) ────
  fichaElements: [
    { id: 'nombre', label: 'Nombre del negocio', explain: 'Es lo primero que ve el cliente. Debe coincidir exactamente con el nombre real del negocio — Google puede rechazar o suspender fichas con nombres que incluyen palabras clave o promociones agregadas artificialmente.' },
    { id: 'categoria', label: 'Categoría', explain: 'Define en qué búsquedas aparece el negocio ("ferretería cerca de mí", por ejemplo). Una categoría mal elegida hace que el negocio no aparezca cuando debería.' },
    { id: 'direccion', label: 'Dirección o zona de atención', explain: 'Si el negocio tiene local físico, se muestra la dirección exacta y aparece en el mapa. Si atiende a domicilio o por zona, se puede configurar un área de servicio en vez de una dirección visible.' },
    { id: 'horario', label: 'Horarios', explain: 'Se muestra si el negocio está "Abierto" o "Cerrado" en tiempo real según el horario cargado — un dato que el cliente revisa antes de ir o llamar.' },
    { id: 'telefono', label: 'Teléfono y WhatsApp', explain: 'Permite que el cliente llame o escriba directo desde la Ficha, sin tener que buscar el número en otro lado.' },
    { id: 'fotos', label: 'Fotografías', explain: 'Fotos del local, productos o trabajos realizados. Generan confianza — un perfil sin fotos transmite menos seriedad que uno con fotos reales del negocio.' },
    { id: 'productos', label: 'Productos o servicios', explain: 'Un listado breve de lo que ofrece el negocio, para que el cliente confirme rápido si tiene lo que busca.' },
    { id: 'resenas', label: 'Reseñas', explain: 'Comentarios y calificaciones de clientes anteriores. Es uno de los factores que más pesa en la decisión de un cliente nuevo.' },
    { id: 'sitio', label: 'Enlace al sitio web', explain: 'Cuando el negocio tiene página propia, la Ficha muestra un botón directo hacia ella. Este negocio todavía no tiene uno — ver el próximo módulo.' }
  ],

  // ── Nodos del ecosistema digital (módulo 5) ─────────────────────────
  ecosystemNodes: [
    { id: 'redes', label: 'Redes sociales', explain: 'Construyen comunidad con quienes ya siguen al negocio: contenido, cercanía, seguidores. No están pensadas para que alguien nuevo encuentre el negocio buscando activamente.' },
    { id: 'google', label: 'Google y Google Maps', explain: 'Es donde aparece el negocio cuando una persona busca activamente algo que necesita, en ese momento, cerca de donde está.' },
    { id: 'landing', label: 'Landing Page', explain: 'Una vez que alguien te encontró (por Google, por redes o por recomendación), la Landing le presenta ordenadamente qué ofrece el negocio y cómo contactarlo.' },
    { id: 'whatsapp', label: 'WhatsApp', explain: 'Es donde la conversación se vuelve concreta: preguntas, cotización, cierre. Todos los caminos anteriores terminan acá.' }
  ],

  // ── Comparación de escenarios (módulo 6) ────────────────────────────
  scenarioComparison: {
    columns: ['Contenido y comunidad', 'Descubrimiento en búsqueda', 'Presentación ordenada', 'Conversación y cierre'],
    rows: [
      { label: 'Solo redes sociales', marks: [true, false, false, true] },
      { label: 'Redes + Ficha de Google', marks: [true, true, false, true] },
      { label: 'Redes + Ficha + Landing', marks: [true, true, true, true] },
      { label: 'Solo Ficha de Google', marks: [false, true, false, true] },
      { label: 'Ficha de Google + Landing', marks: [false, true, true, true] }
    ]
  },

  // ── Casos de urgencia real (módulo 7) ────────────────────────────────
  urgencyCases: [
    {
      business: 'Estudio de Pilates Equilibrio',
      situation: 'Las clases tienen cupo máximo de 8 personas y suelen completarse la misma semana.',
      question: '¿Hay momentos donde se llenan o no dan abasto?',
      correctType: 'A',
      explain: 'Tipo A — Capacidad limitada. El negocio tiene un límite físico real (cupos por clase), no una fecha ni una urgencia inventada.'
    },
    {
      business: 'Cerrajería Rápida 24h',
      situation: 'Cuando alguien queda afuera de su casa o auto, cada minuto sin encontrar una cerrajería cercana es un cliente que puede terminar llamando a otro.',
      question: '¿Hay algo que la gente posterga y le sale más caro no resolver a tiempo?',
      correctType: 'B',
      explain: 'Tipo B — Empeora con el tiempo. La urgencia es del cliente del negocio, no del negocio en sí: cada minuto sin ser encontrado es una oportunidad perdida.'
    },
    {
      business: 'Florería Primavera',
      situation: 'La demanda se dispara en fechas puntuales del año y el resto del tiempo es más pareja.',
      question: '¿Hay fechas o temporadas donde la demanda sube naturalmente?',
      correctType: 'C',
      explain: 'Tipo C — Estacional / por fecha. Conviene mencionar la fecha próxima como contexto real, sin inventar un plazo que no existe.'
    },
    {
      business: 'Muebles a Medida Roble',
      situation: 'Es una decisión de largo plazo — el cliente compara opciones durante semanas antes de decidirse, sin una fecha límite real.',
      question: '¿Por qué alguien debería decidir hoy y no la próxima semana?',
      correctType: 'D',
      explain: 'Tipo D — Sin urgencia real. No hay una respuesta honesta a esa pregunta, así que no se le inventa una. Se avanza con otro gancho: garantía, diferenciador, prueba social — nunca presión de tiempo falsa.'
    }
  ],

  // ── Conversaciones reales (módulo 8) — situación + opciones ─────────
  conversations: [
    {
      prompt: '"Ya tengo Instagram y Facebook, no necesito nada más."',
      options: [
        { text: 'Las redes sirven, pero cuando alguien busca directamente en Google, un negocio sin Ficha ni página no aparece ahí — y el de al lado sí. Las redes complementan, no reemplazan estar en Google.', correct: true },
        { text: 'Las redes sociales ya casi no sirven para conseguir clientes nuevos.', correct: false, why: 'Desacredita una herramienta que sí funciona — nunca se presentan las redes como algo que "ya no sirve".' }
      ],
      feedbackCorrect: 'Correcto — conecta con lo visto en el módulo del ecosistema: ninguna herramienta reemplaza a la otra.',
      feedbackWrong: 'Repasemos esto: nunca se desacredita una herramienta que el cliente ya usa. Se le muestra qué parte del camino no está cubierta todavía.'
    },
    {
      prompt: '"No tengo dinero para esto ahora."',
      context: 'Esta objeción aparece al principio de la conversación (Paso 0), antes de que el cliente conozca el precio. Muchas veces "no tengo plata" es en realidad "pensé que esto era caro".',
      dynamicPrice: true, // el texto de la opción correcta reemplaza {PRICE} por getActivePrice(market, 'ficha') — igual que el Kit
      options: [
        { text: 'Arranca desde {PRICE}, sin gastos grandes de entrada, lista en 48 horas hábiles. No es una inversión grande ni un compromiso a largo plazo.', correct: true },
        { text: 'Entiendo, te dejo tranquilo entonces — cualquier cosa me escribís.', correct: false, why: 'El cliente todavía no conoce el precio real. Cerrar la conversación sin mostrárselo pierde la oportunidad de resolver una objeción que muchas veces es solo una suposición.' }
      ],
      feedbackCorrect: 'Correcto — es la primera vez que el cliente conoce el valor real. No es minimizar su situación: es mostrarle un dato que no tenía. El precio de entrada es accesible.',
      feedbackWrong: 'Repasemos: en este punto de la conversación el cliente todavía no sabe cuánto cuesta. Mostrarle el precio de entrada resuelve la objeción real, que muchas veces es una suposición sobre el costo.'
    },
    {
      prompt: '"Mandame información por WhatsApp."',
      options: [
        { text: 'Dale, te la mando — pero contame primero: ¿qué vendés y para quién es principalmente?', correct: true },
        { text: 'Perfecto, te mando ahora mismo un mensaje con todos nuestros precios y planes.', correct: false, why: 'Enviar información genérica sin diagnosticar antes es publicidad masiva, no una propuesta pensada para ese negocio.' }
      ],
      feedbackCorrect: 'Correcto — primero se diagnostica, después se recomienda. Es la misma regla que se usa en cualquier conversación.',
      feedbackWrong: 'Repasemos esto: mandar información sin preguntar antes no es diagnosticar — es repetir lo mismo para cualquiera.'
    },
    {
      prompt: '"No tengo tiempo ahora."',
      options: [
        { text: 'Sin problema. ¿Te llamo mañana a las once?', correct: true },
        { text: 'Bueno, te llamo después.', correct: false, why: '"Después" no es un horario — un seguimiento sin fecha concreta casi nunca se retoma.' }
      ],
      feedbackCorrect: 'Correcto — un horario concreto convierte una postergación en un seguimiento real.',
      feedbackWrong: 'Repasemos esto: agendar sin una fecha u hora concreta no es agendar.'
    },
    {
      prompt: '"No, no me interesa."',
      options: [
        { text: 'Entiendo, gracias por tu tiempo. Cualquier cosa, quedo a disposición.', correct: true },
        { text: 'Esperá, dejame explicarte una vez más por qué te conviene.', correct: false, why: 'Insistir después de un "no" claro arruina el contacto para siempre — ninguna venta vale eso.' }
      ],
      feedbackCorrect: 'Correcto — no todas las conversaciones terminan en venta, y un "no" claro se respeta sin insistir.',
      feedbackWrong: 'Repasemos esto: insistir después de un "no" claro daña la relación y rara vez cambia la respuesta.'
    }
  ],

  // ── Casos de diagnóstico — elegir la solución (módulo 11) ───────────
  // productKey usa las mismas claves que markets.js: ficha, generico (Express), personalizado (Premium),
  // ficha_generico, ficha_personalizado. "none" = no corresponde vender ninguno de los cinco ahora.
  diagnosisCases: [
    {
      business: 'Taller Mecánico El Motor',
      situation: 'Negocio nuevo, sin Ficha de Google y sin página web. Quiere empezar a recibir clientes por internet.',
      correctProduct: 'ficha_generico',
      explain: 'No tiene ni Ficha ni Landing, así que un pack cubre ambas necesidades a la vez. Como no mencionó querer un dominio propio, Express es el punto de partida — Premium queda como opción si lo pide.'
    },
    {
      business: 'Ferretería El Tornillo',
      situation: 'Ya tiene Ficha de Google activa (la del módulo 2), pero no tiene un lugar propio para presentarse.',
      correctProduct: 'generico',
      explain: 'Ya tiene Ficha — no corresponde ofrecerle una nueva. Le falta exactamente lo que resuelve la Landing.'
    },
    {
      business: 'Estudio de Uñas Brillo',
      situation: 'Muy activa en Instagram, con buena cantidad de seguidores, pero no tiene Ficha de Google, casi no la encuentran cuando alguien busca "manicura cerca de mí", y tampoco tiene una página propia.',
      correctProduct: 'ficha_generico',
      explain: 'La Ficha es la prioridad — es lo primero que resuelve que no aparezca en búsquedas locales. Pero como tampoco tiene una página propia, el diagnóstico completo muestra que el pack (Ficha + Landing) es la recomendación real, no solo la pieza más obvia. Diagnosticar significa revisar todo lo que falta, no quedarse en el primer hueco que se nota.'
    },
    {
      business: 'Barbería Central',
      situation: 'Ya tiene Ficha de Google. Quiere una página simple y rápida, sin gastar en un dominio propio por ahora.',
      correctProduct: 'generico',
      explain: 'Ya tiene Ficha, y pidió explícitamente la opción más económica sin dominio propio — es exactamente Landing Express.'
    },
    {
      business: 'Clínica Dental Sonrisa',
      situation: 'Ya tiene Ficha de Google. Quiere una dirección web propia y profesional para compartir con sus pacientes.',
      correctProduct: 'personalizado',
      explain: 'Ya tiene Ficha, y pidió explícitamente dominio propio — es Landing Premium.'
    },
    {
      business: 'Veterinaria Los Amigos',
      situation: 'Ya tiene Ficha de Google activa y ya tiene un sitio web propio funcionando.',
      correctProduct: 'diagnostico',
      explain: 'Ya resolvió lo que ofrecen los cinco productos de RiO, así que no corresponde forzar la venta de ninguno de ellos. Pero eso no significa que no haya nada para hacer: puede que le falte mejorar el SEO, o que Google no esté valorando bien su Ficha o su sitio. Lo correcto es agendar un diagnóstico para que hable directamente con Brenda — no se resuelve en la llamada, se agenda para revisarlo con calma. No todas las conversaciones terminan en venta de uno de los cinco productos, pero tampoco todas terminan en un simple "no hay nada para ofrecer".'
    }
  ],

  // ── Autoevaluación final (módulo 13) ────────────────────────────────
  finalQuiz: [
    {
      type: 'mcq',
      question: '¿Qué es una Ficha de Google?',
      options: [
        'Una página web con varias secciones.',
        'El perfil del negocio que Google muestra en el buscador y en Maps.',
        'Una cuenta de Instagram verificada.'
      ],
      correctIndex: 1
    },
    {
      type: 'mcq',
      question: '¿Qué es una Landing Page?',
      options: [
        'Una página de una sola sección, enfocada en presentar el negocio y facilitar el contacto.',
        'Un anuncio pago en redes sociales.',
        'Un formulario para pedir cotizaciones automáticas.'
      ],
      correctIndex: 0
    },
    {
      type: 'mcq',
      question: 'Un negocio nuevo, "Panadería Trigal", no tiene Ficha ni Landing y quiere aparecer en Google y tener su propia página, sin pedir dominio propio. ¿Qué le recomendás?',
      options: ['Ficha de Google + Landing Express', 'Solo Landing Premium', 'Solo Ficha de Google'],
      correctIndex: 0
    },
    {
      type: 'mcq',
      question: '¿Cuál de estas afirmaciones sobre redes sociales, Google, Landing y WhatsApp es correcta?',
      options: [
        'Las redes sociales compiten con la Landing — hay que elegir una.',
        'Cada una cubre un tramo distinto del camino: comunidad, descubrimiento, presentación y cierre — se complementan.',
        'Google reemplaza a WhatsApp para cerrar una venta.'
      ],
      correctIndex: 1
    },
    {
      type: 'mcq',
      question: 'Un negocio de mudanzas dice: "no hay una fecha fija, la gente se muda cuando puede". ¿Qué tipo de urgencia es?',
      options: ['Tipo A — Capacidad limitada', 'Tipo C — Estacional', 'Tipo D — Sin urgencia real'],
      correctIndex: 2
    },
    {
      type: 'mcq',
      question: 'El cliente dice: "mandame información por WhatsApp". ¿Cuál es la mejor respuesta?',
      options: [
        'Enviar de inmediato un mensaje con todos los precios y planes.',
        'Preguntar primero qué vende y para quién, antes de mandar algo.',
        'Decirle que llame mejor por teléfono.'
      ],
      correctIndex: 1
    },
    {
      type: 'mcq',
      question: 'Al principio de la llamada, antes de decir ningún precio, el cliente dice: "no tengo plata para esto ahora". ¿Cuál es la mejor respuesta?',
      options: [
        'Mostrarle el precio de entrada — todavía no lo conoce, y muchas veces "no tengo plata" es en realidad "pensé que era caro".',
        'Dejarlo tranquilo y cerrar la conversación sin mostrarle el precio.',
        'Insistir explicando de nuevo los beneficios hasta que cambie de opinión, sin mencionar el precio.'
      ],
      correctIndex: 0
    },
    {
      type: 'mcq',
      question: '¿Cuál es la única diferencia entre Landing Express y Landing Premium?',
      options: [
        'Premium tiene más secciones y funciones.',
        'Premium incluye dominio propio; Express usa subdominio de RiO.',
        'Premium se entrega más rápido.'
      ],
      correctIndex: 1
    },
    {
      type: 'mcq',
      question: '¿Cuál de estas frases NO se debe usar ni prometer nunca?',
      options: [
        '"Tu Ficha queda configurada y enviada a verificación."',
        '"Te garantizo la primera posición en Google."',
        '"La primera versión de tu Landing está en 48 horas hábiles."'
      ],
      correctIndex: 1
    },
    {
      type: 'mcq',
      question: 'Un negocio ya tiene Ficha de Google y ya tiene sitio web propio funcionando. ¿Qué corresponde hacer?',
      options: [
        'Ofrecerle igual un pack para asegurar la venta.',
        'No forzar ninguno de los cinco productos, y agendar un diagnóstico con Brenda por si hay algo para mejorar (SEO, cómo lo valora Google).',
        'Insistir en que su sitio actual seguro está mal hecho.'
      ],
      correctIndex: 1
    }
  ],

  // ── Checklist final del módulo 12 y del cierre de la evaluación ─────
  postConversationSteps: [
    'Conversar con el prospecto.',
    'Detectar su necesidad real.',
    'Recomendar una solución.',
    'Ingresar al Kit digital del Portal.',
    'Registrar las respuestas obtenidas.',
    'Seleccionar mercado, producto y condiciones.',
    'Generar desde el sistema el mensaje oficial de WhatsApp.',
    'Enviar el medio de pago correspondiente.',
    'Permitir que la información llegue por correo y a HubSpot.',
    'Dar paso al trabajo de producción de RiO.'
  ]
};
