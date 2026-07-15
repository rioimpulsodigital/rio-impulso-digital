# WORKFLOW — RiO Impulso Digital

> Reglas de trabajo para el desarrollo del sitio web con Claude Code en VS Code.
> Stack: HTML · CSS · JS · Git · GitHub Pages

---

## 1. Extensiones VS Code recomendadas

Abrir VS Code → `Ctrl+Shift+X` → buscar por nombre exacto → instalar.

| Extensión | Publisher | Para qué sirve |
|---|---|---|
| GitLens | GitKraken | Historial de cambios inline, blame, comparaciones de commits |
| Error Lens | Alexander | Muestra errores y warnings directamente en el código |
| indent-rainbow | oderwat | Colorea niveles de indentación — útil en HTML con CSS mixto |
| Prettier | Prettier | Formateador automático de HTML, CSS y JS |
| Live Server | Ritwick Dey | Servidor local con recarga automática al guardar |

**NO instalar:**

| Extensión | Por qué NO |
|---|---|
| GitHub Copilot | Interfiere con el flujo de trabajo con Claude Code |
| Remote - SSH | Innecesario para este stack |

---

## 2. Configuración Git local

### 2.1 Identidad global (una sola vez por equipo)

**En PowerShell:**
```powershell
git config --global user.name "Brenda Rivera Obando"
git config --global user.email "rio.impulsodigital@gmail.com"
```

### 2.2 Convenciones de commits

| Prefijo | Cuándo usarlo |
|---|---|
| `feat:` | nueva sección, componente o funcionalidad |
| `fix:` | corrección de bug o ruta rota |
| `style:` | cambio visual sin lógica (color, espaciado, tipografía) |
| `refactor:` | reorganización de código sin cambiar resultado |
| `docs:` | cambios en README, WORKFLOW u otros .md |
| `chore:` | configuración, .gitignore, estructura de carpetas |
| `deploy:` | ajuste específico para GitHub Pages |

**Ejemplo correcto:**
```
feat: agregar sección de testimonios con scroll reveal
```

### 2.3 Qué versionar y qué no

**SÍ versionar:**
- `index.html` y cualquier `.html` nuevo
- `assets/css/` — todos los archivos CSS
- `assets/js/` — todos los archivos JS
- `assets/branding/` — logos e imágenes de marca
- `assets/img/` — imágenes del sitio
- `.gitignore`, `WORKFLOW.md`, `README.md`

**NO versionar:**
- `.env` (si en algún momento se usa)
- Archivos temporales o backups (`.bak`, `.tmp`)
- Carpeta `dist/` si se genera algún build

---

## 3. Reglas de trabajo con Claude Code

### 3.1 Reglas de proceso

**1. Leer antes de escribir**
Antes de implementar cualquier tarea, leer todos los archivos relevantes. Nunca escribir código basándose en suposiciones sobre el contenido actual de los archivos.

**2. Verificar antes de avanzar**
Nunca pasar a la siguiente tarea sin confirmar que la actual funciona, o dejar una nota explícita de qué quedó pendiente. Si algo falla, diagnosticar antes de continuar.

**3. No avanzar sin confirmación de resultados**
Cuando se pide verificar algo (visual en browser, comportamiento en mobile), esperar confirmación antes de continuar. No asumir que funcionó.

**4. Un cambio a la vez en producción**
Cuando se haga deploy a GitHub Pages: subir y verificar un cambio antes del siguiente. No hacer push con múltiples cambios sin validar individualmente.

**5. Explicar decisiones importantes brevemente**
Si una decisión técnica no es obvia (por qué esta estructura, por qué este selector, por qué este enfoque), explicar en pocas palabras mientras se implementa.

### 3.2 Reglas técnicas — HTML/CSS/JS

**Paths relativos siempre**
GitHub Pages no tiene servidor propio. Todos los paths de assets deben ser relativos (`./assets/css/main.css`) para que funcionen tanto en local como en el dominio publicado. Nunca usar paths absolutos (`/assets/...`).

**CSS y JS siempre externos**
No escribir CSS en `<style>` inline ni JS en `<script>` inline en el HTML. Todo va en `assets/css/` y `assets/js/`. Excepción aceptada: variables críticas above-the-fold en `<style>` si hay razón de performance documentada.

**`defer` en todos los scripts**
```html
<script src="./assets/js/main.js" defer></script>
```
El `defer` garantiza que el JS se ejecuta después de que el DOM esté cargado, evitando errores de elementos no encontrados.

**Verificar en browser antes de commit**
Abrir el archivo con Live Server o directamente en el browser antes de hacer cualquier commit. No commitear código que no se haya visto funcionar.

**Responsive: mobile-first en media queries**
Escribir estilos base para mobile, luego sobreescribir con `@media (min-width: ...)` para desktop cuando sea necesario.

### 3.3 Dónde se ejecuta cada cosa

Antes de cada comando, se especifica el entorno:
- **En PowerShell local:** comandos Git, npm, configuración
- **En Live Server / navegador:** verificación visual
- **En GitHub:** configuración de Pages, revisión del repo

---

## 4. Estructura de carpetas del proyecto

```
rio-impulso-digital/
├── assets/
│   ├── branding/               → logos y archivos de marca (no modificar)
│   ├── css/
│   │   ├── main.css            → variables globales, reset, nav, footer, hero principal
│   │   ├── utilitaria.css      → estándar Tipo C — componentes para páginas utilitarias
│   │   └── landing-solucion.css → estilos específicos para páginas de solución (landing)
│   ├── js/
│   │   └── main.js             → scripts principales (nav, scroll, FAQ)
│   ├── img/                    → imágenes del sitio (fotos, ilustraciones)
│   └── docs/                   → documentos descargables (PDF, etc.)
├── interno/                    → Portal Interno (protegido por Cloudflare Access)
│   ├── index.html              → índice del portal — estándar Tipo C
│   ├── kit-venta-ficha-y-landing-page.html
│   └── rio-guia-comercial.html
├── index.html                  → página principal (landing corporativa)
├── agenda.html                 → página de agendamiento — estándar Tipo C
├── utilitaria-template.html    → plantilla oficial de Página Utilitaria (Tipo C)
├── .gitignore
├── WORKFLOW.md                 → este archivo
└── README.md                   → descripción pública del proyecto
```

> Si se agregan nuevas páginas utilitarias (ej. `/gracias`, `/privacidad`), usar `utilitaria-template.html` como base y linkear `main.css` + `utilitaria.css`. Ajustar paths de assets según el nivel del directorio (`./assets/` desde la raíz, `../assets/` desde subdirectorios).

---

## 5. Informe de Implementación (Tipo A)

Cuando se completa una tarea de implementación, generar un **Informe Tipo A** y escribirlo directamente en el **cuerpo de la página de la tarea en Notion**.

**Cómo escribirlo en Notion:** `notion-update-page` con `command: "insert_content"` y `position: {"type": "end"}` sobre la página de la tarea existente. Nunca en comentarios, subpáginas ni páginas separadas.

**Estructura del informe:**

```
# Informe de Implementación — [ID]
**Tipo A · Anthy · [YYYY-MM-DD]**

---

## 1. Cambios realizados

### `ruta/archivo.html` — descripción del cambio

**Eliminado:**
- ...

**Incorporado:**
- ...

[Secciones adicionales según la tarea: una por área de cambio relevante]

---

## N. Resultado

| Antes | Después |
|---|---|
| ... | ... |

---

**Estado:** ✅ Completa.
```

**Reglas:**
- El encabezado siempre incluye `Tipo A · Anthy · [fecha]`
- Secciones numeradas, una por área de cambio (archivo o componente)
- Tabla "Resultado" comparando antes/después al final
- Firmado como **Anthy**, nunca como "Claude Code" o "Codie"
- El informe va en el cuerpo de la página de la tarea — no crear páginas separadas

---

## 6. Deploy a GitHub Pages

### 6.1 Flujo básico

1. Verificar cambios en browser local (Live Server)
2. `git add [archivos específicos]` — nunca `git add .` sin revisar qué incluye
3. `git commit -m "tipo: descripción"`
4. `git push origin main`
5. Esperar ~30-60 segundos y verificar en la URL pública

### 6.2 Configuración inicial de GitHub Pages

En el repositorio de GitHub:
- Settings → Pages → Source: `Deploy from branch`
- Branch: `main` / `/ (root)`
- Guardar

La URL pública será: `https://brendario.github.io/rio-impulso-digital/`

---

*Documento mantenido por Anthy (Claude Code) — RiO Impulso Digital | Julio 2026*
