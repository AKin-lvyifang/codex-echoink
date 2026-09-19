

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink">
    <img width="1024" alt="Cartel de lanzamiento de Codex EchoInk v1.4.0 que muestra tarjetas de progreso de Conocimiento rediseñadas, comandos validados y informes más claros." src="docs/images/codex-echoink-v1.4.0-release.png">
  </a>
</p>

<h1 align="center">Codex EchoInk</h1>

<p align="center">
  <a href="#features">Características</a> ·
  <a href="docs/echoink-product-whitepaper.md">Whitepaper</a> ·
  <a href="#why-echoink">Por qué EchoInk</a> ·
  <a href="#whats-new">Novedades</a> ·
  <a href="#install">Instalación</a> ·
  <a href="#quick-start">Inicio rápido</a> ·
  <a href="#privacy-and-permissions">Privacidad</a> ·
  <a href="#screenshots">Capturas de pantalla</a> ·
  <a href="#development">Desarrollo</a> ·
  <a href="#license">Licencia</a> ·
  <a href="README_CN.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">
    <img src="https://img.shields.io/badge/platform-Obsidian_Desktop-7C3AED?style=flat-square&logo=obsidian&logoColor=white" alt="Plataforma: Obsidian Desktop">
    <img src="https://img.shields.io/badge/version-v1.4.0-0EA5E9?style=flat-square" alt="Versión v1.4.0">
    <img src="https://img.shields.io/badge/license-MIT-10B981?style=flat-square" alt="Licencia MIT">
    <img src="https://img.shields.io/badge/language-English_%2B_%E4%B8%AD%E6%96%87-F59E0B?style=flat-square" alt="README en inglés y chino">
  </a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest"><strong>Descargar v1.4.0</strong></a>
  ·
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">Última versión</a>
</p>

---

## Características

### Guía de configuración inicial

<img width="1024" alt="Guía de configuración inicial de Codex EchoInk verifica Codex CLI, inicio de sesión de Codex, OpenCode, servidor y modelos antes de Iniciar." src="docs/images/codex-echoink-setup-guide-v0.6.0.png">

- Verifica Codex CLI, inicio de sesión de Codex, CLI de OpenCode, servidor de OpenCode, modelos y readiness del Agente antes de que el usuario inicie.
- Muestra primero los requisitos faltantes, con comandos de instalación, botones de copiado y enlaces a documentación.
- Permite a los usuarios hacer clic en `Run check again` después de instalar o iniciar sesión, y muestra `Start` solo cuando las verificaciones bloqueantes están despejadas.
- `Start` abre la barra lateral de EchoInk y registra la finalización de la configuración; no envía un mensaje ni ejecuta una tarea de Conocimiento.
- Mantiene la configuración explícita: sin instalaciones silenciosas, sin trabajo de fondo sorpresa del Agente.

### Espacio de trabajo multiagente

- Abre el Agente EchoInk en la barra lateral de Obsidian.
- Admite Codex CLI, API de OpenCode y Hermes como backends de Agente intercambiables.
- Enruta los tres backends a través de un solo orquestador (Harness) de EchoInk, con estados de ejecución compartidos, reglas de contexto, gestión de sesiones y proyección de conversación.
- Cambia el Agente principal desde el encabezado de la barra lateral sin borrar la sesión actual de EchoInk.
- Requiere un selector de carpetas para sesiones de chat ordinarias antes de enviar.
- Trata las notas adjuntas solo como contexto de turno; adjuntar una nota no convierte toda la bóveda en el espacio de trabajo.
- Mantiene el canal `Knowledge` vinculado a la bóveda actual para el mantenimiento de Raw, Wiki, Outputs y Inbox.
- Permite que el backend de Agente seleccionado lea archivos, inspeccione carpetas, edite documentos y ejecute operaciones locales permitidas según sus capacidades.
- Mantiene el flujo de trabajo dentro de Obsidian en lugar de saltar entre aplicaciones.

### Línea de tiempo de procesos estilo Agente

- Usa la misma línea de tiempo de EchoInk para Codex, OpenCode y Hermes en lugar de cambiar el diseño de la conversación con el backend.
- Mantiene la respuesta final prominente mientras el razonamiento, comandos, ediciones de archivos y llamadas MCP permanecen en una línea de tiempo de procesamiento expandible.
- Muestra solo el tiempo de procesamiento cuando está colapsada, y revela el proceso completo cuando se expande.
- Muestra chips de archivos para archivos modificados, con archivos de la bóveda que se abren de nuevo en Obsidian.
- Mantiene visibles los tokens por turno y el uso de contexto sin permitir que los registros crudos dominen la conversación.
- Admite modo Agente / Plan, selección de modelo, esfuerzo de razonamiento, velocidad y modos de permiso de archivos.

### Cola de turnos

<img width="1024" alt="Cola de turnos y menús del compositor de Codex EchoInk muestran tres actualizaciones de estabilidad para la interacción de entrada en cola." src="docs/images/codex-echoink-turn-queue-v0.7.2.png">

- Encola tareas de seguimiento mientras el turno actual del Agente aún está en ejecución.
- Mantiene las colas limitadas a cada sesión, para que el chat ordinario y el trabajo del canal de Conocimiento no se mezclen.
- Captura el texto exacto, adjuntos, Skill, modelo, permisos, modo y espacio de trabajo en el momento de la encolación.
- Muestra tarjetas encoladas sobre el compositor, con eliminar y arrastrar para reordenar el trabajo que no ha comenzado.
- Ejecuta el siguiente elemento solo después de que la tarea actual tenga éxito; detener o fallar pausa la cola hasta que la reanudes.
- Mantiene los comandos de Conocimiento como `/ask`, `/maintain` y `/journal` en serie, para que no se ejecuten simultáneamente.

### Panel de inicio (Home Dashboard)

<img width="1024" alt="Panel de inicio de Codex EchoInk con calendario, salud del conocimiento, mapa de calor de actividad y tarjetas de notas." src="docs/images/codex-echoink-home-dashboard-v1.0.0.png">

- Abre una pestaña de Home de EchoInk al iniciar si está habilitada en la configuración.
- Añade un comando de Obsidian para reabrir Home después de cerrar la pestaña.
- Hace que el ícono de la cinta abra tanto la barra lateral de EchoInk como el panel de Home.
- Muestra el estado de Wiki, trabajo pendiente de Raw, puntuación de salud, mapa de calor de revisiones anuales, calendario y actividad reciente.
- Muestra una corriente de tarjetas de notas responsiva que se adapta a pantallas de laptops más pequeñas.
- Filtra tarjetas por estado, grupo de recomendación, hora de actualización, relevancia y carpeta de primer nivel.
- Copia enlaces internos de Obsidian, rutas relativas y enlaces Markdown desde cada tarjeta.

### Operaciones de la base de conocimientos

<img width="1024" alt="Seguridad de Conocimiento de Codex EchoInk muestra Raw Protegido, Historial Local y Hilos Archivados." src="docs/images/codex-echoink-knowledge-safety-v0.8.0.png">

- Añade un canal persistente de `Knowledge` para mantener la bóveda actual de Obsidian.
- Trata el chat como la superficie de control principal: escribe `/init`, `/ask`, `/check`, `/maintain`, `/outputs`, `/journal` o `/inbox`, luego añade tu propia instrucción después del comando.
- Añade una guía de inicialización de Wiki LLM: `/init` previsualiza carpetas, archivos de reglas y sugerencias de enrutamiento de notas existentes; `/init confirm` crea la plantilla.
- Responde preguntas de conocimiento de solo lectura con `/ask`, buscando en Wiki primero y luego usando Journal / Outputs como evidencia de fondo, mientras separa la evidencia de la Bóveda de suplementos externos o basados en modelos.
- Escribe diarios diarios con `/journal`, siguiendo la estructura actual de la carpeta `journal/` y el formato reciente de notas; la ventana de jornada laboral es de `00:00` hasta antes de las `06:00` del día siguiente, con reglas de evidencia específicas del backend para Codex CLI, API de OpenCode o Hermes.
- Mantiene solo el día activo de Conocimiento más reciente en el canal; el historial de chat anterior se almacena por día en la carpeta de datos `history/` del plugin y se navega a través de `/history`.
- Muestra ejecuciones de base de conocimientos de Codex CLI con las mismas tarjetas de proceso que los chats ordinarios de Agente: razonamiento, comandos, cambios de archivos, llamadas a herramientas y resultados finales.
- Muestra un panel de salud de Conocimiento fijado sobre el canal: archivo de reglas, conteos de Raw/Wiki/Inbox, estado de salud, tabla detallada de carpetas de Wiki, tabla de Raw/Inbox y un mapa de calor de revisiones de un año completo.
- Usa `LLM-WIKI.md` como fuente de reglas de la base de conocimientos por defecto, o otro Markdown de la Bóveda seleccionado en la configuración. Antes de cada ejecución de Conocimiento, EchoInk lee el contenido más reciente, lo valida y lo inyecta en el contexto del sistema; un archivo ilegible o ausente bloquea el inicio del Agente. `AGENTS.md` puede estar ausente y nunca se fusiona como reglas de Conocimiento.
- Incluye EchoInk Memory V2 como una capa local paralela sin deshabilitar o reemplazar la memoria nativa de Codex, OpenCode o Hermes. El chat de Agente ordinario y `/ask` reciben un pequeño catálogo del sistema para búsqueda bajo demanda a través de registros locales que permanecen dentro de sus ventanas de retención independientes y pueden recuperar la misma memoria local curada a través de sesiones y backends; el archivo nunca se carga por completo. Las cargas útiles de ejecución detalladas tienen 30 días por defecto y los resúmenes de ejecución acotados 90 días, mientras que la retención de Conversación, Artefacto de Flujo y Memoria formal permanecen independientes. Los flujos de mantenimiento de registros solo graban resultados después de que el commit local tenga éxito. Los datos curados canónicos viven en la Bóveda `.echoink/memory/index.json`; la configuración soporta inicialización, sincronización, recuperación, manejo de conflictos, eliminación e importación explícita desde `.codex-memory` legado. El externo [`codex-memory-lite`](https://github.com/AKin-lvyifang/codex-memory-lite) permanece compatible como una herramienta separada, pero ya no es requerido para la memoria a largo plazo de EchoInk.
- Recopila artículos de WeChat, páginas web y archivos de texto en Fuentes Raw antes del procesamiento.
- Usa un protocolo de digest en cuatro pasos: entender Raw, extraer conocimiento reutilizable, fusionar conocimiento estructurado en Wiki / Projects, luego marcar Raw solo después de que se verifique la evidencia de la fuente.
- Mantiene los archivos Raw existentes sin cambios, luego escribe resultados estructurados en Wiki / Projects, Outputs, Journal y archivos de seguimiento.
- Ejecuta `/check` solo como auditoría de digest, `/maintain` como digest de cuatro pasos, `/reingest` como redigest forzado y `/calibrate raw` como calibración de estado sin nueva extracción de Agente.
- Preserva el historial de Conocimiento en la carpeta local `history/` del plugin, para que `/history` aún pueda mostrar registros después de que los hilos archivados de Codex se eliminen.
- Archiva hilos de fondo de Codex creados por comandos de Conocimiento después de guardar el historial local, reduciendo el desorden en la lista de conversaciones recientes de Codex Desktop.
- Soporta ejecuciones manuales y mantenimiento diario cuando Obsidian está abierto.

### Revisiones semanales

- Añade una pestaña de configuración `Review`, con automatización programada deshabilitada por defecto.
- Permite habilitar revisiones semanales de `Knowledge` y `Agent chat` por separado.
- Ejecuta por defecto cada domingo a las 21:00, con recuperación la próxima vez que se abra Obsidian.
- Escribe archivos Markdown y HTML coincidentes a `outputs/obsidian-weekly-review/`.
- Usa una plantilla fija de panel HTML y la abre a través de la vista previa incorporada de EchoInk.

### Integración local primero

- Reutiliza el estado de inicio de sesión local de Codex CLI cuando se selecciona Codex.
- Puede usar OpenCode o Hermes como backends de Agente locales cuando están instalados y configurados.
- No requiere almacenar una clave API de OpenAI por defecto.
- Soporta opcionalmente proveedores personalizados compatibles con la API de Responses de OpenAI, incluyendo múltiples modelos por proveedor.
- Soporta configuraciones de proxy local para el proceso hijo de Codex.
- Mantiene los interruptores de MCP, Skill y bundles de herramientas limitados a la bóveda actual en lugar de reescribir la configuración global de Codex, OpenCode o Hermes.
- Añade una base de broker MCP de EchoInk: recursos MCP con configuraciones de conexión explícitas `metadata.mcp` pueden listar herramientas y ejecutar llamadas de herramientas aprobadas a través de registros de EchoInk; entradas de MCP solo importadas permanecen visibles pero no se marcan falsamente como invocables.
- Añade búsqueda e interruptores por ámbito para recursos de la bóveda actual: chat, Conocimiento y acciones de escritura.

### Modo backend multiagente

- Mantiene el modo original de Codex CLI para usuarios que quieran reutilizar el estado de inicio de sesión local de Codex.
- Añade modo API de OpenCode para tareas de chat, escritura y conocimiento cuando OpenCode está instalado localmente.
- Puede detectar o conectarse a un servidor OpenCode, actualizar modelos disponibles y elegir el modelo OpenCode activo.
- Puede actualizar y elegir Agentes OpenCode, para que diferentes flujos de trabajo de gestión de conocimiento puedan usar diferentes perfiles de agente.
- Añade configuraciones CLI/API de Hermes para usuarios que quieran perfiles, memoria y configuración de proveedor de Hermes como backend.
- La configuración de proveedor/modelo de Hermes se deja intencionalmente a la configuración oficial de Hermes como `hermes model` o sus archivos de entorno; EchoInk almacena solo los metadatos de conexión seleccionados.
- EchoInk aplica un diseño de conversación y un conjunto de estados terminales a través de backends. La cantidad de detalle de eventos nativos aún depende de lo que exponga cada Agente.

### Mecanismo de contexto de escritura

- Añade acciones de reescritura, expansión, continuación y traducción al inglés en el editor para texto seleccionado.
- Permite elegir modos de calidad de escritura `Fast`, `Quality` o `Strict`.
- Usa comprensión visible del artículo para contexto de formato largo en lugar de ejecutar resúmenes de fondo en silencio.
- Muestra un panel de contexto de escritura con la nota actual, modelo, estado de comprensión y comprensión estructurada del artículo.
- Reutiliza la comprensión del artículo después de ediciones pequeñas, para que ejecuciones continuas de reescribir / expandir / continuar / traducir no vuelvan a leer toda la nota repetidamente.
- Muestra un candidato en línea que se puede aceptar con `Enter` o cancelar con `Esc`.
- Puede ejecutarse a través de Codex, OpenCode o Hermes dependiendo del backend de escritura configurado.
- Trata la reescritura, expansión, continuación y otras acciones de escritura como tareas de utilidad con su propio enrutamiento de modelo rápido, sin cambiar el modelo de chat principal.

Esta característica aún es experimental y está deshabilitada por defecto, pero v0.3.0 la convierte en un flujo de trabajo de escritura mucho más deliberado.

### Mejora de prompts y enrutamiento de marcadores

- Añade una acción Sparkles al compositor de la barra lateral para mejorar un borrador de solicitud antes de enviarlo.
- Da a la mejora de prompts su propio backend de Agente, proveedor, ruta API y configuración de modelo, independiente del Agente de chat principal y las acciones de escritura del editor.
- Usa el Meta-Prompt WorkBuddy incorporado y permite al usuario seguir editando o restaurar la entrada original.
- Combina la captura de artículos de WeChat y páginas web públicas en una sola acción Bookmark que enruta la URL pegada automáticamente.

## Por qué EchoInk

Codex EchoInk convierte la tinta en un códice, para luego hacerla resonar como nuevas ideas.

- `Ink` es el registro: notas, recortes, borradores, fuentes y conversaciones.
- `Codex` es la base de conocimientos: páginas de wiki estructuradas, índices, informes y enlaces de fuentes trazables.
- `Echo` es la capa de activación: preguntas conscientes de la bóveda, ejecuciones de mantenimiento, ayuda de escritura y flujos de trabajo de inspiración futura.

El nombre coincide con el ciclo de Obsidian: registrar, organizar y recibir un impulso hacia el siguiente pensamiento.

## Novedades

### v1.4.0

<img width="1024" alt="Cartel de lanzamiento de Codex EchoInk v1.4.0 que muestra tarjetas de progreso de Conocimiento rediseñadas, comandos validados e informes más claros." src="docs/images/codex-echoink-v1.4.0-release.png">

**Conversaciones duraderas y mantenimiento de Conocimiento más seguro:** EchoInk ahora preserva un historial de conversación recuperable a través de cambios de contexto y backends de Agente, mientras que el mantenimiento de Conocimiento valida el trabajo antes de que llegue a la Bóveda.

- Reanuda conversaciones existentes de Chat y Conocimiento después de migración de almacenamiento, rotación de contexto, recargas del plugin o cambios de backend sin reconstruir la sesión manualmente.
- Ejecuta `/maintain` a través de un flujo de trabajo protegido que aísla intentos fallidos, valida artefactos y confirma un resultado aceptado antes de actualizar informes o el estado de Raw.
- Mantiene el historial de conversaciones, ejecuciones de flujo, artefactos comerciales y sesiones nativas de Agente bajo reglas de retención y recuperación separadas.
- Usa un selector de sesión compacto y buscable con sesiones en ejecución protegidas y gestión por lotes para chats completados.
- Expande y colapsa informes de Conocimiento de manera confiable, luego abre notas de la Bóveda referenciadas directamente desde el informe.
- Las notas existentes de la Bóveda y las conversaciones de EchoInk se actualizan automáticamente; no se requiere migración manual ni reinicio de sesión.

### v1.3.0

<img width="1024" alt="Cartel de lanzamiento de Codex EchoInk v1.3.0 que muestra configuración guiada, un tiempo de ejecución multiagente, memoria local y modelos de utilidad." src="docs/images/codex-echoink-v1.3.0-release.png">

**Espacio de trabajo multiagente listo para producción:** Codex, OpenCode y Hermes ahora comparten una ruta de configuración guiada, proyección de tiempo de ejecución y modelo de recuperación. EchoInk también añade Memory V2 local y controles de modelo de utilidad conscientes del backend.

- Configura, repara, revuelve y monitorea los tres backends de Agente desde un solo panel de configuración.
- Lee el mismo diseño de conversación respuesta-primer a través de backends, con razonamiento público y herramientas disponibles en la línea de tiempo de proceso expandible.
- Usa Memory V2 para recuperación curada localmente a través de sesiones y backends mientras preserva la memoria nativa de cada Agente.
- Recarga y valida el Markdown de reglas de Conocimiento seleccionado antes de cada ejecución sin requerir `AGENTS.md`.
- Mantiene la mejora de prompts independiente del modelo de chat principal, elige un modelo específico del backend o añade un ID de modelo personalizado.
- Los archivos de la Bóveda y sesiones de EchoInk existentes no requieren migración.

### v1.2.2

**Corrección de compatibilidad de revisión:** Los menús de parámetros del Agente ahora siguen las APIs de estilo aprobadas de Obsidian, resolviendo el fallo automatizado de revisión de fuente reportado para `v1.2.1`.

- El posicionamiento, visibilidad y comportamiento de interacción del menú permanecen sin cambios.
- Los archivos de la Bóveda, sesiones y configuración existentes no requieren migración.

### v1.2.1

<img width="1024" alt="Menú de comandos ligero de Conocimiento de Codex EchoInk con selección por teclado." src="docs/images/codex-echoink-v1.2.1-command-menu.png">

**Menú de comandos de Conocimiento ligero:** Escribir `/` en el canal de Conocimiento ahora abre una lista responsiva más limpia con texto neutro y un estado activo gris claro en lugar de tarjetas coloreadas pesadas.

- Usa `ArrowUp` y `ArrowDown` para navegar por los comandos; la selección se envuelve y permanece visible en listas largas.
- Presiona `Enter` para rellenar el comando seleccionado sin enviarlo, o `Escape` para cerrar el menú.
- Los archivos de la Bóveda, sesiones y configuración existentes no requieren migración.

### v1.2.0

<img width="1024" alt="Cartel de lanzamiento de Codex EchoInk v1.2.0 que muestra un solo Harness, chat reconstruido y utilidades rápidas." src="docs/images/codex-echoink-v1.2.0-release.jpg">

**Orquestador (Harness) de Agente unificado y barra lateral reconstruida:** EchoInk ahora posee un ciclo de vida de ejecución, ruta de contexto y proyección de conversación para Codex, OpenCode y Hermes. Toda la barra lateral también ha sido reconstruida alrededor de una conversación respuesta-primer más clara y un compositor más ligero y responsivo.

**Rediseño de backend:**

- Chat, Conocimiento, escritura y mejora de prompts ahora entran en un solo Harness de EchoInk antes de que un adaptador hable con el backend seleccionado.
- Codex, OpenCode y Hermes comparten estados de ejecución, reglas de contexto, arrendamientos de sesión nativa, comportamiento de detención y semántica de tiempo de espera.
- Cambiar el Agente principal se aplica al siguiente turno sin borrar la sesión actual de EchoInk. Las anulaciones explícitas por capacidad aún tienen prioridad.

**Reconstrucción de UI:**

- Las respuestas finales permanecen prominentes mientras el razonamiento, comandos, ediciones y llamadas de herramientas viven en una línea de tiempo de procesamiento expandible.
- La selección de espacio de trabajo, estado Plan, Bookmark, Skill, mejora de prompts, permisos, modelo, razonamiento y velocidad ahora usan un compositor responsivo estilo Codex.
- El encabezado añade un interruptor de tres Agentes y botones MCP / Configuración más ligeros. Los menús de parámetros se reposicionan para permanecer dentro de barras laterales estrechas.

**Nuevas capacidades y correcciones:**

- Añadida configuración independiente de mejora de prompts con el Meta-Prompt WorkBuddy y una acción Restaurar concisa.
- Añadido enrutamiento automático de modelo rápido para tareas de escritura y utilidad de prompts sin cambiar el modelo de chat principal.
- Combinada captura de WeChat y páginas web públicas en una sola entrada Bookmark.
- Corregido desplazamiento con salto de mensajes, parpadeo de tarea/informe de Conocimiento, estados terminales inconsistentes, actualizaciones obsoletas del compositor o mejorador de prompts y desbordamiento de barra lateral estrecha.

**Cómo usar:**

1. Instala `v1.2.0` y recarga Obsidian.
2. Elige Codex, OpenCode o Hermes desde el encabezado de EchoInk.
3. Usa el ícono Sparkles para mejorar un prompt borrador, o abre la configuración cuando quieras anular su modelo de utilidad.
4. Los archivos de la Bóveda, sesiones y configuración de modelo personalizada existentes no requieren migración.

### v1.1.0

<img width="1024" alt="Cartel de lanzamiento de Codex EchoInk v1.1.0 que muestra Broker de Herramientas, Línea de Tiempo de Proceso y Digest en Cuatro Pasos." src="docs/images/codex-echoink-v1.1.0-release.png">

**Herramientas de Agente y actualización de digest de Conocimiento:** EchoInk ahora puede mostrar más de lo que un Agente está haciendo, conectar herramientas limitadas a la bóveda más claramente y guiar el mantenimiento de Conocimiento a través de un flujo de digest estricto de cuatro pasos.

**Qué cambió:**

- Añadida base de broker de herramientas para recursos de la bóveda, herramientas MCP, Skills y bundles de herramientas, con interruptores por ámbito más claros.
- Mejorada la línea de tiempo de proceso del Agente para que búsquedas, trabajo de archivos, llamadas de herramientas y estados de finalización sean más fáciles de seguir.
- Añadida ruta de digest de Conocimiento más estricta: entender Raw, extraer conocimiento reutilizable, fusionarlo en Wiki / Projects, luego marcar Raw solo después de verificar la evidencia de la fuente.
- Añadido el primer punto de entrada de backend Hermes, manteniendo la configuración de modelo y proveedor de Hermes en Hermes mismo.
- Dividida la gran vista de barra lateral del Agente en módulos UI más pequeños, haciendo la revisión y mantenimiento futuro de UI más seguros.

**Cómo usar:**

1. Instala `v1.1.0`.
2. Abre EchoInk en Obsidian y elige el backend de Agente que ya usas.
3. Usa `/check`, `/maintain` o `/reingest` en el canal de Conocimiento cuando quieras que EchoInk inspeccione o digiera notas Raw.
4. Abre la configuración para revisar interruptores de recursos para chat, Conocimiento y acciones de escritura.

### v1.0.3

**Corrección de estilo de revisión:** Esta actualización aborda la regla de revisión de la comunidad de Obsidian para asignación directa de estilo sin cambiar el flujo de trabajo de EchoInk.

**Qué cambió:**

- Reemplazadas asignaciones directas de estilo de barra lateral con `setCssStyles` y `setCssProps` soportados por Obsidian.
- Mantenido el tooltip de salud, mapa de calor anual, lista virtual de mensajes y comportamiento del anillo de uso de contexto sin cambios.
- Añadida cobertura de regresión para prevenir que la asignación directa de estilo regrese a la barra lateral del Agente.

**Cómo usar:**

1. Instala `v1.0.3`.
2. Abre el Home de EchoInk o la barra lateral del Agente como de costumbre.

### v1.0.2

**Lanzamiento de compatibilidad de revisión:** Esta actualización corrige hallazgos de revisión de la comunidad de Obsidian sin cambiar el flujo de trabajo central de EchoInk.

**Qué cambió:**

- El registro de vistas ahora devuelve vistas directamente en lugar de almacenar en caché instancias de vista en el plugin.
- La descarga del plugin ya no desacopla forzadamente hojas de EchoInk, preservando el diseño de espacio de trabajo del usuario.
- El plugin ya no depende de APIs de Obsidian más nuevas que la `minAppVersion` declarada.

**Cómo usar:**

1. Instala `v1.0.2`.
2. Abre el Home de EchoInk, la barra lateral del Agente o la vista previa de revisión como de costumbre.

### v1.0.1

**Lanzamiento de pequeñas correcciones:** Esta actualización ajusta el calendario de Home, el mantenimiento de Conocimiento y el comportamiento de lectura de archivos grandes.

**Qué cambió:**

- El calendario de Home ahora soporta controles de mes anterior, mes siguiente y retorno al mes actual.
- `/maintain` verifica duplicados de conflicto de Wiki numerados y los mueve a `outputs/maintenance/conflict-duplicates-*`.
- El mantenimiento de Conocimiento ahora bloquea páginas duplicadas de Wiki estilo `Title 2.md`, prefiriendo la página canónica o un informe de conflicto.
- El panel, descubrimiento de Raw y `/ask` ahora usan lecturas de archivos acotadas para evitar cargar PDFs grandes, imágenes y archivos Markdown enormes en la memoria.
- Los archivos Raw sobre el presupuesto de lectura no se escriben en el seguimiento y no se marcan como procesados.

**Cómo usar:**

1. Instala `v1.0.1`.
2. Ejecuta `/maintain` si tu Wiki tiene páginas duplicadas numeradas.
3. Revisa el informe de mantenimiento para duplicados movidos y archivos Raw grandes omitidos en esta ejecución.

### v1.0.0

**Actualización del panel de inicio (Home dashboard):** EchoInk ahora se abre como un centro de comando de base de conocimientos dentro de Obsidian.

**Qué cambió:**

- Añadida una pestaña de Home cerrable que puede abrirse por defecto y puede reabrirse desde la paleta de comandos de Obsidian.
- Hecho que el ícono de la cinta abra tanto la barra lateral de EchoInk como el panel de Home.
- Añadidos módulos de estado de Home para salud de Wiki, trabajo pendiente de Raw, mapa de calor de revisiones anuales, calendario, puntuación de salud y conteos clave de la bóveda.
- Añadida una corriente responsiva de tarjetas de notas para actualizaciones recientes de Wiki y recomendaciones.
- Añadidos filtros y ordenamiento para etiquetas, hora de actualización, relevancia y carpetas de primer nivel.
- Añadidas acciones de tarjeta para copiar enlaces internos de Obsidian, rutas relativas y enlaces Markdown.

**Cómo usar:**

1. Habilita Home al iniciar en la configuración de EchoInk.
2. Abre Home desde el ícono de la cinta o la paleta de comandos de Obsidian.
3. Usa los filtros sobre las tarjetas para enfocarte en la vista de la base de conocimientos.
4. Usa cada menú de tarjeta para copiar el formato de enlace que necesitas.

### v0.8.0

**Actualización de seguridad de Conocimiento:** Las fuentes Raw, el historial local y los hilos de fondo de Codex ahora se manejan como capas separadas.

**Qué cambió:**

- Reforzada la protección de fuentes Raw a través de `/check`, `/maintain` y `/calibrate raw`, incluyendo rollback más seguro cuando una tarea falla o se cancela.
- Mantenido el historial de Conocimiento legible desde el almacén local `history/` del plugin en lugar de depender de conversaciones archivadas de Codex Desktop.
- Archivados hilos de fondo de Codex creados por comandos de Conocimiento después de guardar los resultados de la tarea, reduciendo el desorden en la lista reciente de Codex Desktop.
- Hecho que la cancelación de tareas de Conocimiento, reintentos de error, tiempos de espera y guardados de estado sean más fáciles de recuperar y entender en la UI.
- Actualizado el conteo de Raw del panel para enfocarse en notas de fuente reales en lugar de contar archivos de imagen `.assets/` como notas Raw.

**Cómo usar:**

1. Ejecuta `/check` para una auditoría de digest de solo lectura.
2. Ejecuta `/maintain` para ejecutar el digest de cuatro pasos en fuentes Raw cambiadas.
3. Usa `/history` para navegar por el historial local de Conocimiento; eliminar conversaciones archivadas de Codex no elimina el historial del plugin.

### v0.7.2

**Actualización de estabilidad:** Cola de turnos y menús del compositor ahora se cierran de manera más predecible.

**Qué cambió:**

- Hacer clic dentro del área del compositor pero fuera de los menús de Skill y comandos de Conocimiento ahora cierra los menús del compositor abiertos.
- Hacer clic en un menú de Skill o comando de Conocimiento ya no cierra ese menú por error.
- Añadida cobertura de regresión para el contenedor de menús del compositor, manteniendo la UI de entrada en cola estable.

### v0.7.1

**Actualización de estabilidad:** Cola de turnos ahora maneja éxito, fallo, detención y concurrencia de tareas de Conocimiento de manera más predecible.

**Qué cambió:**

- Las tareas exitosas continúan la cola solo cuando otro elemento está esperando.
- Las tareas fallidas o detenidas pausan la cola y mantienen el trabajo restante para reanudación manual.
- Los turnos encolados ya no inician mientras un turno ordinario, tarea de Conocimiento o inicio de cola ya está en progreso.
- Arrastrar tarjetas de cola permanece dentro de la UI de la cola en lugar de filtrarse al área de caída de adjuntos del compositor.

### v0.7.0

**Nueva característica:** Cola de turnos para chat ordinario y tareas del canal de Conocimiento.

**Qué cambió:**

- Añadida una cola con ámbito de sesión sobre el compositor.
- Mientras una tarea está en ejecución, un compositor no vacío cambia el botón principal a `Enqueue`.
- Con un compositor vacío, el mismo botón aún detiene la tarea actual.
- Los elementos de la cola capturan texto, adjuntos, Skill seleccionado, modelo, permiso, modo y espacio de trabajo en el momento de la encolación.
- Las tareas exitosas avanzan automáticamente al siguiente elemento encolado.
- Las tareas fallidas o detenidas pausan la cola y mantienen los elementos restantes para reanudación manual.
- Los comandos de Conocimiento como `/ask`, `/maintain` y `/journal` ahora ejecutan en serie a través de la cola.

**Cómo usar:**

1. Inicia un chat o comando de Conocimiento.
2. Escribe la siguiente tarea mientras la actual está en ejecución.
3. Haz clic en `Enqueue`.
4. Reordena o elimina elementos en espera sobre el compositor.
5. Si una tarea se detiene o falla, haz clic en `Resume queue` cuando estés listo.

### v0.6.0

**Guía de configuración y actualización de mantenimiento de conocimiento:** añade una guía de entorno de primer uso, reviciones más seguras, un paso claro de `Start` y fronteras de mantenimiento de Conocimiento más fuertes.

**Nuevas características:**

- Añadida una guía de configuración inicial en la configuración para Codex CLI, inicio de sesión de Codex, CLI de OpenCode, servidor de OpenCode, modelos y readiness del Agente.
- Añadidos comandos de instalación, botones de copiado y enlaces de documentación cuando falta un tiempo de ejecución requerido.
- Añadido `Run check again` para volver a detectar rutas CLI, actualizar el inicio de sesión de Codex y reconectar o iniciar OpenCode cuando sea necesario.
- Añadido `Start` como un paso explícito de finalización de configuración. Abre la barra lateral de EchoInk sin enviar un mensaje ni ejecutar una tarea de Conocimiento.

**Correcciones y mantenimiento:**

- Añadida detección de rutas de Windows para Codex CLI y OpenCode CLI.
- Actualizado el historial de Conocimiento a almacenamiento de archivo basado en días con herramientas de configuración para indexación, exportación y compactación.
- Ajustado el mantenimiento de Conocimiento para que las tareas de Agente no puedan reescribir directamente cuerpos de fuente Raw; la normalización de ruta raw es manejada por verificaciones del lado del plugin.
- Mejorados informes de mantenimiento de Conocimiento, estado del panel, enlaces de notas locales y colocación de entradas de historial.

### v0.5.2

**Actualización de flujo de trabajo de Conocimiento y diagnósticos de Windows:** añade informes de revisión semanal, mejora `/journal`, hace las ejecuciones de Conocimiento más fáciles de inspeccionar y corrige el defecto `gpt-5.5` por defecto que podría activar fallos de WebSocket en Windows.

**Nuevas características:**

- Añadidas revisiones semanales de Conocimiento y chat de Agente, con ejecuciones programadas o manuales y salida Markdown + HTML en `outputs/obsidian-weekly-review/`.
- Añadida una vista previa HTML de EchoInk para informes de revisión semanal generados.
- Añadidos accesos directos `/week` y `/week agent` en el canal de Conocimiento.
- Actualizado `/journal` para escribir en la estructura actual `journal/daily/YYYY-MM/YYYY-MM-DD-周X.md`, crear carpetas de diario faltantes y usar una ventana de trabajo fija de `00:00` a `06:00` del día siguiente.
- Añadida recopilación de historial de chat de OpenCode para `/journal` cuando el backend de Conocimiento usa API de OpenCode.
- Expandida evidencia de `/ask` desde `wiki/` a `wiki/`, `journal/` y `outputs/`, con cubos de citas, líneas de excerpt, relevancia y razones de coincidencia.
- Añadido interruptor de idioma en la configuración para UI de configuración en chino / inglés.

**Correcciones:**

- Cambiado el modelo por defecto de Codex CLI a `Auto`; defectos guardados existentes de `gpt-5.5` migran a `Auto`.
- Eliminadas rutas de respaldo codificadas de `gpt-5.5` restantes de tareas de Conocimiento y modo Plan.
- Añadidos diagnósticos detallados de Codex para WebSocket, rechazo de proxy, CLI faltante, tiempo de espera y errores de salida del servidor de app.
- Añadida guía de solución de problemas para Windows `responses_websocket` / `os error 10061`.
- Simplificadas configuraciones de Review para que la generación manual de informes tenga confirmación y rutas de salida más claras.
- Muestra ejecuciones de Conocimiento de Codex CLI a través de la línea de tiempo de proceso normal, para que el razonamiento, comandos, ediciones de archivos y resultados finales permanezcan en un flujo visible único.
- En el canal de Conocimiento, mensajes ordinarios ahora permanecen como chat de Agente normal. Solo comandos explícitos `/ask`, `/query`, `/问` o `/查询` activan preguntas y respuestas de Conocimiento.
- El botón principal del canal de Conocimiento ahora detiene el chat de Agente ordinario cuando ese chat está en ejecución, en lugar de cancelar el mantenimiento de Conocimiento por error.
- Los fallos de Conocimiento ahora mantienen más detalles completos de app-server, JSON-RPC, OpenCode y errores de turno para una solución de problemas más fácil.
- Las rutas de notas de bóveda local y rutas de informes en respuestas de Conocimiento se renderizan como enlaces de notas clicables.

### v0.5.1

**Corrección de revisión de la comunidad:** eliminada la palabra redundante `Obsidian` de la descripción de `manifest.json` y eliminado el campo manifiesto legado `main` para satisfacer verificaciones automatizadas de la comunidad.

### v0.5.0

**Lanzamiento listo para la comunidad:** renombrado el plugin a `Codex EchoInk`, preparado el id de plugin de comunidad `codex-echoink`, y añadidas divulgaciones de privacidad y permisos más claras para la revisión de Obsidian.

**Qué cambió:**

- Renombrado el plugin de `Codex for Obsidian` / `obsidian-codex` a `Codex EchoInk` / `codex-echoink`.
- Actualizadas rutas de instalación, enlaces de lanzamiento, salida de empaquetado y referencias de repositorio visibles para el nuevo nombre de comunidad.
- Mantenido compatibilidad con archivos de mensaje raw grandes almacenados por instalaciones manuales anteriores bajo `.obsidian/plugins/obsidian-codex/raw`.
- Añadidas notas de privacidad y permisos que cubren Codex CLI, OpenCode, proveedores de modelos, claves API locales y fronteras de escritura de la bóveda.
- Preparados los tres activos que la instalación de la Comunidad de Obsidian lee: `main.js`, `manifest.json` y `styles.css`. El `codex-echoink-0.5.0.zip` separado era un bundle de conveniencia para instalación manual, no un activo de la Comunidad.

### v0.4.1

**Nueva característica:** Refinamientos del canal de Conocimiento para consulta, visibilidad y control día a día.

**Qué cambió:**

- Añadido `/ask` para preguntas de conocimiento de solo lectura. Busca en `wiki/` primero, envía las notas más relevantes como contexto y pide al Agente distinguir evidencia de la Bóveda de información suplementaria.
- Mantenido P&R de Conocimiento de solo lectura detrás de `/ask` explícito; mensajes de lenguaje natural ordinarios permanecen como chat de Agente normal en el comportamiento actual.
- Actualizado el mapa de calor de salud de Conocimiento de una tira reciente corta a una vista estilo GitHub de un año completo con etiquetas de mes, etiquetas de día de la semana, estados de éxito y verificaciones fallidas.
- Añadidos controles de modelo y esfuerzo de razonamiento de Codex CLI directamente en el compositor del canal de Conocimiento. La tarea de Conocimiento ya no tiene que usar un nivel de razonamiento codificado.
- Añadidas cajas de búsqueda a las pestañas de capacidades `Plugins`, `MCP` y `Skills` de la bóveda actual. La búsqueda cubre nombre, id/ruta, metadatos y descripción, y múltiples palabras funcionan como un filtro AND.
- Corregidas filas de capacidades largas cortando nombres, rutas y descripciones con elipsis, para que la casilla de verificación del lado derecho permanezca visible y clicable.
- Mantenido `LLM-WIKI.md` como archivo de reglas de Conocimiento por defecto mientras se permite seleccionar otro Markdown de la Bóveda. EchoInk ahora fuerza la carga del archivo seleccionado para cada ejecución y ya no recurre a `AGENTS.md`.

**Cómo usar:**

1. Abre el canal `Knowledge`.
2. Escribe `/ask tu pregunta` cuando quieras que el canal de Conocimiento busque fuentes de la bóveda.
3. Usa el botón de modelo inferior en modo Codex CLI para elegir el modelo y esfuerzo de razonamiento para tareas de Conocimiento.
4. Expande el panel de salud para revisar el mapa de calor de verificaciones de un año completo.
5. Abre la configuración del plugin, ve a la gestión de capacidades de la bóveda actual, luego busca dentro de `Plugins`, `MCP` o `Skills` antes de alternar elementos.

### v0.4.0

**Nueva característica:** Operaciones de Base de Conocimientos para mantenimiento automatizado de la bóveda de Obsidian.

**Qué cambió:**

- Añadido un canal persistente de base de conocimientos vinculado a la bóveda actual.
- Añadidas plantillas de comandos: `/check`, `/maintain`, `/outputs`, `/journal` y `/inbox`.
- Añadidos puntos de entrada de captura de WeChat, páginas web y archivos para Fuentes Raw.
- Añadido archivo de reglas de base de conocimientos configurable. `LLM-WIKI.md` es el defecto; un archivo Markdown personalizado puede reemplazarlo.
- Ese lanzamiento añadió un punto de entrada de compatibilidad externo `codex-memory-lite`. Los lanzamientos actuales incluyen EchoInk Memory V2 y ya no requieren un skill externo para memoria a largo plazo.
- Añadida selección de modelo OpenCode y selección de Agente OpenCode para modo API de OpenCode.
- Añadida traducción de texto seleccionado al inglés desde el menú contextual del editor.
- Mejorado el alineamiento de la página de configuración de base de conocimientos, copia de estado y selector de archivo de reglas.
- Mantenido la frontera de seguridad: los archivos Raw existentes no se reescriben, eliminan o archivan automáticamente.

**Cómo usar:**

1. Abre el canal `Knowledge` en la barra lateral del Agente.
2. En la configuración, elige `Codex CLI` o `OpenCode API` como backend de base de conocimientos.
3. Para modo OpenCode, instala OpenCode localmente, luego actualiza y selecciona un modelo y Agente.
4. Para una bóveda nueva, escribe `/init` para previsualizar la configuración de LLM Wiki; escribe `/init confirm` solo después de revisarlo.
5. Usa el panel de salud fijado para verificar reglas, conteos de Raw/Wiki/Inbox, razones de riesgo, actualizaciones de carpetas e historial reciente de `/check`.
6. Escribe `/check broken links`, `/maintain new raw sources` o `/outputs weekly notes` en el canal de conocimiento.
7. Usa los accesos directos de captura para recopilar artículos de WeChat, páginas web o archivos en Fuentes Raw.

### v0.3.0

**Nueva característica:** Mecanismo de contexto de escritura para reescritura, expansión y continuación en el editor.

**Qué cambió:**

- Añadidos modos de calidad de escritura `Fast`, `Quality` y `Strict`.
- Añadida comprensión visible del artículo en el panel de contexto de escritura de la barra lateral.
- Añadida comprensión estructurada del artículo para tema, audiencia, propósito, estructura, hechos, estilo, fronteras de fabricación y guía de escritura local.
- Añadida reutilización suave para comprensión del artículo, para que pequeñas ediciones continuas reutilicen comprensión existente en lugar de ejecutarla cada vez.
- Añadida revisión de modo estricto, que verifica el candidato generado antes de mostrarlo.
- Mantenido el flujo de candidato en línea: `Enter` acepta, `Esc` cancela.
- Mantenido la comprensión del artículo fuera del historial de chat normal.

**Cómo usar:**

1. Habilita acciones de escritura en la configuración del plugin.
2. Elige el modo de calidad de escritura por defecto: `Fast`, `Quality` o `Strict`.
3. Selecciona texto en el editor y ejecuta `Rewrite`, `Expand` o `Continue`.
4. Haz clic en el chip `Writing` en la barra lateral para inspeccionar o actualizar la comprensión del artículo.
5. Presiona `Enter` para aceptar el candidato gris, o `Esc` para cancelar.

### v0.2.0

**Corrección de error:** corregido `spawn codex ENOENT` después de reinicio de sesión de cuenta Codex detectando la ruta CLI de Codex Desktop y añadiendo un botón de actualización manual de inicio de sesión.

**Característica experimental:** reescribir, expandir y continuar texto seleccionado del editor en su lugar. Esto aún es experimental, deshabilitado por defecto y no recomendado para uso diario estable.

**Cómo probar:**

1. Habilita acciones de escritura en la configuración del plugin.
2. Selecciona texto en el editor y haz clic derecho en `Rewrite`, `Expand` o `Continue`.
3. Presiona `Enter` para aceptar el candidato gris, o `Esc` para cancelar.
4. Prueba primero en notas no críticas.

### v0.1.2

**Nueva característica:** los lanzamientos públicos ahora mantienen el repositorio de GitHub enfocado solo en archivos de instalación y uso.

**Cómo usar:**

1. Descarga el paquete de lanzamiento más reciente.
2. Instala la carpeta del plugin `codex-echoink`.
3. Usa el plugin sin navegar por documentos internos del proyecto.

### v0.1.1

**Nueva característica:** pega capturas de pantalla de WeChat o del sistema directamente en la caja de entrada de Codex.

**Cómo usar:**

1. Toma una captura de pantalla.
2. Haz clic en la caja de entrada de Codex.
3. Presiona `Command+V`, luego envía.

## Instalación

1. Instala e inicia sesión en Codex CLI para modo Codex CLI.
2. Opcionalmente instala OpenCode o Hermes si quieres esos backends de Agente locales.
3. Instala `Codex EchoInk` desde los Plugins de la Comunidad de Obsidian cuando esté disponible.
4. Para instalación manual, crea esta carpeta en tu bóveda:

```text
<vault>/.obsidian/plugins/codex-echoink/
```

5. Descarga `main.js`, `manifest.json` y `styles.css` desde [el último lanzamiento](https://github.com/AKin-lvyifang/codex-echoink/releases/latest), luego pon los tres archivos en esa carpeta.
6. Reinicia Obsidian y habilita `Codex EchoInk` en plugins de la comunidad.

La carpeta del plugin debería contener:

```text
codex-echoink/
  main.js
  manifest.json
  styles.css
```

## Inicio rápido

1. Abre la barra lateral del Agente EchoInk desde el ícono de la cinta o la paleta de comandos.
2. Elige una carpeta como espacio de trabajo en una sesión de chat ordinaria.
3. Elige el backend de Agente por defecto en la configuración: Codex, OpenCode o Hermes.
4. Pídele al Agente seleccionado que inspeccione, resuma, reescriba o gestione archivos en ese espacio de trabajo.
5. Adjunta notas, archivos, imágenes, Skills o recursos MCP importados cuando sea necesario; los adjuntos son solo contexto.
6. Revisa las tarjetas de proceso para comandos, ediciones, uso de contexto y evidencia. Codex tiene la línea de tiempo más rica; OpenCode y Hermes usan un estado de ejecución más simple cuando eventos más ricos no están disponibles.
7. Abre el canal `Knowledge` cuando quieras que EchoInk opere tu base de conocimientos de la bóveda a través del backend seleccionado.
8. Para una bóveda nueva, comienza con `/init`; para una bóveda estructurada existente, comienza con `/check`, luego usa `/ask`, `/maintain`, `/reingest`, `/calibrate raw` o `/outputs` dependiendo de si quieres una respuesta, digest de cuatro pasos, redigest, calibración de estado o salida de conocimiento estructurado.

## Solución de problemas

### WebSocket en Windows o `os error 10061`

Si los registros de Codex CLI mencionan `responses_websocket`, `wss://chatgpt.com/backend-api/codex/responses`, `actively refused` o `os error 10061`, el fallo generalmente está en la conexión WebSocket de inicio de sesión de ChatGPT de Codex CLI.

Intenta estos pasos:

1. Configura el modelo por defecto del plugin en `Auto`, o elige un modelo distinto de `gpt-5.5`.
2. Si tu red requiere un proxy local, habilita la configuración de proxy del plugin e introduce una URL como `http://127.0.0.1:7890`.
3. Reconecta Codex desde la página de configuración, o reinicia Obsidian.
4. Si aún falla, comparte el nuevo error detallado del plugin y las líneas relevantes del registro de Codex CLI con detalles de cuenta eliminados.

## Privacidad y permisos

- Codex EchoInk es solo para escritorio porque llama a herramientas de línea de comandos locales.
- EchoInk mismo no requiere pago ni una cuenta de EchoInk. Los proveedores individuales de Agente o modelo pueden requerir su propia cuenta, autorización, suscripción o cargos de uso; esos términos del proveedor y políticas de privacidad se aplican.
- El modo Codex CLI usa tu inicio de sesión local de Codex CLI y puede enviar prompts seleccionados, adjuntos y contexto de archivo elegido al proveedor de modelo configurado en Codex.
- El modo API de OpenCode se conecta a un servidor OpenCode local o configurado por el usuario. El plugin puede iniciar o detener `opencode serve`, pero no instala OpenCode en silencio.
- El modo Hermes llama a tu CLI local de Hermes o servidor API de Hermes configurado. EchoInk puede almacenar la URL del servidor Hermes seleccionado, perfil, proveedor, modelo y clave de servidor API opcional, pero no reescribe en silencio tu configuración global de proveedor de Hermes.
- Las claves de proveedor API personalizado se almacenan en datos del plugin de Obsidian en tu máquina local. Úsalas solo en un dispositivo confiable. Las claves de proveedor de inferencia de Hermes normalmente deberían permanecer en la propia configuración de Hermes.
- El plugin no sube tu bóveda completa por defecto. El chat ordinario requiere elegir una carpeta de espacio de trabajo, y las notas adjuntas son solo contexto de turno.
- Las ejecuciones de gestión de Conocimiento mantienen los cuerpos de fuente Raw de solo lectura y solo actualizan índices o seguimientos. En chat de Agente ordinario, la organización de archivos Raw sigue tu instrucción explícita y el modo de permiso activo.
- El acceso fuera de la bóveda se usa para espacios de trabajo y adjuntos que seleccionas explícitamente, más rutas de configuración, instalación, temporales y de tiempo de ejecución requeridas por herramientas de Agente locales configuradas. Los modos de arena de Agente pueden permitir acceso de lectura fuera del espacio de trabajo seleccionado, y `Danger full access` elimina restricciones del sistema de archivos; usa ese modo solo con prompts y herramientas confiables. EchoInk no escanea silenciosamente carpetas del sistema no relacionadas por su cuenta.
- Durante una ejecución `/journal` respaldada por Codex, EchoInk puede instruir al Agente seleccionado para leer solo las fechas objetivo bajo `~/.codex/sessions/YYYY/MM/DD/*.jsonl` como evidencia opcional para el diario diario solicitado. EchoInk no precarga esos archivos ni escanea fechas de sesión no relacionadas.
- Para Colección de WeChat, EchoInk verifica la ruta fija `~/.codex/skills/wechat-article-to-obsidian-raw/scripts/wechat_capture.mjs` y ejecuta ese script con Node cuando está presente para que el artículo solicitado pueda archivarse. No busca otros directorios de Skill; si el script no está disponible o no devuelve una nota, EchoInk usa su captura de página incorporada.
- EchoInk pasa el entorno de proceso actual a CLIs de Agente seleccionados, subprocesos de instalador o servicio de Agente y comandos MCP stdio configurados por el usuario para que puedan encontrar `PATH`, `HOME`, proxy, proveedor y configuraciones específicas de comando. Configura solo comandos locales confiables. EchoInk mismo no usa hostname, información de usuario o variables de entorno para huella digital o telemetría.
- El acceso de red de configuración es activado por el usuario: la configuración de Codex y OpenCode usa el registro npm configurado en tu máquina. La configuración de Hermes descarga una revisión fijada de Hermes desde `github.com/NousResearch/hermes-agent` y un archivo `uv` fijado desde `github.com/astral-sh/uv`. Luego ejecuta `uv venv --python 3.11`, lo que puede contactar `api.github.com` y `github.com/astral-sh/python-build-standalone` para descargar un runtime Python 3.11 gestionado cuando ninguno esté disponible. El siguiente `uv sync --locked` descarga las dependencias exactas del lockfile desde servicios de paquetes Python, normalmente `pypi.org` y `files.pythonhosted.org`. Estas descargas se usan solo para instalar o reparar Hermes.
- Cuando pegas una página web pública o URL de WeChat en Colección, EchoInk solicita directamente la URL proporcionada con `requestUrl` de Obsidian para descargar y extraer la página. Para WeChat, se prueba primero el script de captura fija anterior cuando está disponible y la captura `requestUrl` incorporada es el respaldo. EchoInk no evade páginas de inicio de sesión, verificación o CAPTCHA.
- Después de elegir autorización Nous, EchoInk solicita el catálogo de modelos recomendados desde `portal.nousresearch.com`. El tráfico de inferencia de Agente y MCP va solo al proveedor, servidor API o servidor MCP que configuraste.
- EchoInk no tiene servicio de telemetría del lado del cliente ni del lado del servidor propio. Los proveedores remotos de Agente, modelo, API y MCP pueden retener registros de servicio bajo sus propias políticas de privacidad.
- La enumeración completa de la bóveda está reservada para búsqueda explícita de Conocimiento, panel, mantenimiento, previsualización de inicialización y selección de archivo de reglas de conocimiento. Las rutas de archivos conocidas deben accederse directamente en lugar de escanear toda la bóveda.
- El acceso al portapapeles ocurre solo cuando pegas un adjunto, haces clic en una acción de copiado o eliges el respaldo de instalación etiquetado `Open terminal and copy command`. EchoInk no lee ni monitorea el portapapeles en segundo plano.
- Los recursos de MCP y Skill se importan a un registro local de la bóveda de EchoInk. Los interruptores por ámbito afectan solo a EchoInk y no se escriben de vuelta a configuraciones globales de Codex, OpenCode o Hermes. Las llamadas de herramientas MCP que pasan por el broker de EchoInk requieren configuración de conexión explícita, aprobación y registros locales.

## Capturas de pantalla

![Espacio de trabajo real de Home y barra lateral de Agente de Codex EchoInk v1.2.0](docs/images/codex-echoink-v1.2.0-real-home.png)

![Interruptor de Codex, OpenCode y Hermes de Codex EchoInk v1.2.0](docs/images/codex-echoink-v1.2.0-real-agent-switcher.png)

![Modo Plan y compositor reconstruido de Codex EchoInk v1.2.0](docs/images/codex-echoink-v1.2.0-real-plan-composer.png)

![Panel de inicio de Codex EchoInk](docs/images/codex-echoink-home-dashboard-v1.0.0.png)

![Cola de turnos y menús del compositor de Codex EchoInk](docs/images/codex-echoink-turn-queue-v0.7.2.png)

![Seguridad de Conocimiento de Codex EchoInk](docs/images/codex-echoink-knowledge-safety-v0.8.0.png)

![Flujo de trabajo de base de conocimientos de Codex EchoInk](docs/images/codex-echoink-knowledge-usage-v0.5.0.png)

![Demo de barra lateral de Codex EchoInk](docs/images/codex-echoink-vault-answer.png)

## Desarrollo

```bash
npm install
npm run test
npm run typecheck
npm run build
```

Genera un paquete de instalación manual local:

```bash
npm run package
```

Despliega en tu propia bóveda de Obsidian:

```bash
OBSIDIAN_VAULT=/path/to/your/vault npm run deploy
```

## Requisitos

- Codex CLI debe estar instalado y disponible localmente para modo Codex CLI.
- OpenCode debe estar instalado localmente para modo API de OpenCode. El plugin puede conectarse o iniciar el servidor OpenCode, pero no instala OpenCode en silencio.
- Hermes CLI debe estar instalado localmente para modo Hermes. Configura proveedores de inferencia a través de Hermes, luego apunta EchoInk al CLI o servidor API.
- Los proveedores API personalizados para modo Codex CLI deben ser compatibles con la API Responses de OpenAI, como `/v1/responses`. Los proveedores que solo soportan `/v1/chat/completions` pueden no funcionar.
- Las claves API personalizadas se almacenan en datos del plugin de Obsidian, así que úsalas solo en una máquina local confiable.
- Deja las rutas CLI vacías para detectar automáticamente desde `PATH` y carpetas de instalación comunes, o establece rutas manualmente en la configuración del plugin.

## Licencia

Codex EchoInk es de código abierto bajo la [Licencia MIT](LICENSE).

Puedes usar, copiar, modificar, fusionar, publicar, distribuir, sublicenciar y vender copias de este software según lo permitido por la Licencia MIT, siempre que se incluya el aviso de copyright y licencia. El software se proporciona "tal cual", sin garantía de ningún tipo.
