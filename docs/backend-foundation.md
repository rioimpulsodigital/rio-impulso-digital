# Fundación del backend — RIO-110

> Arquitectura técnica de la fundación (Pages Functions + D1 + validación
> server-side de Cloudflare Access). No duplica la especificación funcional
> completa de RIO-97 — solo lo necesario para instalar, correr y extender esto.

## Qué es y qué no es

Esta fundación **no** implementa ninguna regla de negocio (usuarios, roles,
ventas, comisiones — eso es RIO-111 en adelante). Solo deja:

- La estructura de carpetas de Pages Functions.
- Una capa de acceso a D1 reutilizable, con manejo de errores centralizado.
- Validación server-side del JWT de Cloudflare Access.
- Un formato uniforme de respuestas/errores.
- Controles básicos de seguridad (CORS, método, tamaño de body, headers).
- Un endpoint técnico de salud (`/interno/api/health`).
- Migraciones D1 versionadas, con una única tabla técnica (`_system_health`).

## Estructura

```
functions/
  _shared/
    access.js      → verificación server-side del JWT de Access (RS256, JWKS cacheado)
    db.js           → capa de acceso a D1 (query/execute/transaction/checkConnectivity)
    response.js      → formato uniforme de respuestas y errores + headers de seguridad
    security.js       → CORS restringido, allowlist de métodos, límite de body
  interno/
    api/
      _middleware.js  → se aplica a todo /interno/api/*: requestId, CORS preflight,
                         Access (deny-by-default), captura de errores no controlados
      health.js        → GET /interno/api/health

migrations/
  0001_system_health.sql
  0002_system_health_index.sql

tests/
  access.test.js    → JWT de Access: válido, ausente, malformado, firma inválida,
                       aud/emisor incorrecto, vencido, JWKS caído, kid rotado
  db.test.js         → capa de acceso a D1 (con un binding D1 simulado)
  health.test.js      → endpoint de salud (método, D1 disponible/caído)
  response.test.js     → formato uniforme
  security.test.js      → CORS, método, Content-Type, tamaño de body

wrangler.toml
.dev.vars.example    → nombres de variables/secretos requeridos (sin valores)
```

Cómo agregar un módulo nuevo (RIO-111+): una carpeta nueva bajo
`functions/interno/api/<recurso>/`, con su propio archivo por método/ruta.
El middleware de `_middleware.js` ya cubre identidad y CORS para cualquier
ruta nueva dentro de `/interno/api/*` sin tener que repetirlo — no hace falta
tocar ese archivo salvo que cambie una regla transversal.

## Por qué Pages Functions y no un Worker separado

Confirmado en la auditoría RIO-108 (sección 6): Pages Functions son Workers
desplegados junto al sitio estático, en el mismo proyecto/dominio ya
protegido por Cloudflare Access — cero cambios de DNS ni de la aplicación de
Access existente. No se encontró una incompatibilidad técnica que justificara
un Worker separado.

## Instalación local

```bash
npm install
```

Requiere Node ≥ 20 (usa `node --test`, el runner de pruebas nativo — sin
dependencias extra de testing). `wrangler` queda fijado como devDependency
(4.127.0 al momento de esta tarea).

## Variables y secretos (nombres únicamente)

| Nombre | Tipo | Dónde vive | Estado |
|---|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | variable pública | `wrangler.toml` → `[vars]`; configurada también en el entorno Preview del proyecto real | ✅ Configurado (28/08/2026) |
| `CF_ACCESS_AUD` | secreto | `wrangler pages secret put CF_ACCESS_AUD` (producción/preview) · `.dev.vars` (local, no versionado) | 🔴 Pendiente — requiere permisos de Access/Zero Trust que Anthy no tiene (RIO-109) |
| `DB` | binding D1, no es una variable | `wrangler.toml` → `[[d1_databases]]`; configurado también en el entorno Preview del proyecto real | ✅ Configurado (28/08/2026) |

Copiar `.dev.vars.example` a `.dev.vars` (ya en `.gitignore`) y completar el
valor real solo en la máquina local — nunca commitear ni pegar el valor en
Notion, chat o capturas.

## Ejecutar las pruebas

```bash
npm test
```

41 pruebas, todas corren sin ninguna cuenta ni credencial de Cloudflare real:

- `access.test.js` genera un par de claves RSA local y simula el endpoint
  `/cdn-cgi/access/certs` interceptando `fetch` — prueba las 7+ variantes de
  JWT pedidas en la sección 12 de la tarea.
- `db.test.js` usa un binding D1 simulado en memoria.
- Todas pasaron en esta sesión (`node --test tests/*.test.js` → 41/41 ✅).

## Migraciones

```bash
npm run db:migrations:apply:local     # aplica contra D1 local (sin Cloudflare)
npm run db:migrations:list             # lista cuáles ya se aplicaron
npm run db:migrations:apply:preview    # aplica contra D1 de preview real (requiere token válido)
```

Verificado en esta sesión, 100% local (`--local`, sin token de Cloudflare):

- Las dos migraciones (`0001`, `0002`) se aplicaron en orden.
- Wrangler las registró como aplicadas (tabla de control propia de D1) —
  volver a ejecutar `apply` no vuelve a correrlas (`✅ No migrations to apply!`).
- Se agregó la migración `0002` sin editar la `0001`, y ambas convivieron sin
  conflicto — así es como se agrega un módulo nuevo a futuro (una migración
  más, nunca editando una ya aplicada).
- Insertar y leer una fila de `_system_health` funcionó correctamente contra
  la base local.

## Token de Cloudflare y base D1 real (28/08/2026)

El token `anthy-rio-deploy` (creado en RIO-109) se validó con éxito
(`wrangler whoami`) — el "Invalid API Token" que había devuelto antes era un
problema de copiado del valor, no del token en sí. Con eso resuelto:

- Se creó `rio-ventas-preview` en la cuenta real (`wrangler d1 create`,
  región ENAM), `database_id` cargado en `wrangler.toml`.
- Las migraciones `0001`/`0002` se aplicaron contra esa base **remota real**
  (`--remote`, no `--local`) y se verificaron con una fila de prueba.
- El binding D1 `DB` y la variable `CF_ACCESS_TEAM_DOMAIN` se configuraron
  sobre el entorno **Preview** del proyecto de Pages real, vía la API de
  Cloudflare (`PATCH .../pages/projects/rio-impulso-digital`,
  `deployment_configs.preview`) — el entorno **Production** se verificó
  explícitamente sin cambios antes y después de cada PATCH.
- **Hallazgo:** el primer deploy de la rama (antes de tener el `database_id`
  real) falló en la etapa `deploy` de Cloudflare Pages — confirma que el
  build de Pages sí valida `wrangler.toml` (el placeholder
  `PENDIENTE_WRANGLER_D1_CREATE_RIO_110` no es un ID válido). El siguiente
  deploy, ya con el ID real, completó todas las etapas (`queued` → `deploy`)
  en `success`.
- Sigue pendiente únicamente el secreto `CF_ACCESS_AUD` (ver tabla arriba) —
  sin él, la validación de JWT contra la app real de Access todavía no se
  puede probar en la vista previa desplegada (localmente sí, con un valor de
  prueba en `.dev.vars`).

## Validación de Access (server-side)

`functions/_shared/access.js` verifica, usando únicamente Web Crypto (sin
librerías de JWT):

1. Presencia del token (header `Cf-Access-Jwt-Assertion`, con la cookie
   `CF_Authorization` como respaldo — mismo valor que ya usa `users.js` en
   el navegador).
2. Formato del JWT (3 partes) y algoritmo (`RS256` únicamente).
3. Firma, verificada contra el JWKS del equipo
   (`https://<team-domain>/cdn-cgi/access/certs`), cacheado 1 hora.
4. `exp`/`nbf` (vigencia temporal).
5. `iss` (emisor = el team domain configurado).
6. `aud` (coincide con `CF_ACCESS_AUD` de esta aplicación).
7. Comportamiento seguro si el JWKS no está disponible o la clave (`kid`) no
   se encuentra tras un refresco — se rechaza, nunca se asume válido.

**No** se confía en decodificar el JWT con `atob()` sin verificar firma (la
limitación conocida de `users.js`, documentada desde RIO-91/97) — este módulo
es el primer punto del proyecto que sí verifica la firma del lado servidor.

## Endpoint de salud

`GET /interno/api/health` — requiere Access válido (lo aplica el
middleware antes de llegar acá). Devuelve `200` si Pages Functions, Access y
D1 (binding + conectividad) están todos operativos; `503` si D1 no está
disponible. Nunca expone token, JWT, correos, variables de entorno, SQL ni
detalles de infraestructura — verificado en `health.test.js`.

Probado end-to-end con `wrangler pages dev` local en esta sesión:
sin token → `401` uniforme; preflight `OPTIONS` desde el origen del propio
Portal → CORS permitido; desde un origen ajeno → sin headers de CORS; el
sitio estático y `/interno/*` existente siguen sirviendo sin regresiones.

## Formato de respuestas y errores

Ver `functions/_shared/response.js`. Todo endpoint devuelve
`{ ok, data, error, requestId }`. Los mensajes de error son siempre texto
seguro para mostrar — el detalle técnico real (razón interna, stack) solo se
registra en logs del lado servidor, nunca se envía al cliente (ver también
`access.js`/`db.js`: cada `reason`/`DbError` interno se loguea con
`requestId`, nunca con datos sensibles ni la consulta/JWT completos).

## Rollback

- **Código:** esta fundación vive en la rama `rio-110-backend-foundation`,
  no fusionada a `main` — revertirla es simplemente no fusionar la rama (o,
  si ya se fusionó, un `git revert` del merge commit).
- **Migraciones D1:** no son reversibles automáticamente (D1/SQLite no tiene
  "down migrations" nativas) — el rollback de una migración de producción es
  una migración nueva que deshace el cambio (ej. `DROP INDEX`, `DROP TABLE`
  con respaldo previo), nunca editar ni borrar el archivo ya aplicado.
- **D1 preview:** al no ser producción, el rollback más simple ante un
  problema serio es borrar y recrear la base de preview — no hay datos reales
  de clientes en ella (ver "Fuera de alcance" de RIO-110).

## Qué corresponde a preview y qué a producción

| | Preview (esta tarea) | Producción (fuera de alcance de RIO-110) |
|---|---|---|
| D1 | `rio-ventas-preview` (creada y vinculada, 28/08/2026) | Base de producción — **no se crea en RIO-110** |
| Rama | `rio-110-backend-foundation` (y cualquier otra rama que no sea `main`) | `main` |
| Acceso | Vistas previas ya protegidas con Access (RIO-109) | `rioimpulsodigital.com` |
| Quién puede fusionar | — | Requiere aprobación expresa de Brenda (fuera de esta tarea) |

## Cómo continuar desde RIO-111

RIO-111 (identidad, roles, mercados, planes versionados) puede apoyarse
directamente en:

- `functions/_shared/db.js` para toda consulta/transacción nueva — no
  reescribir el acceso a D1 desde cero.
- `functions/_shared/access.js` para resolver `identity.email` ya verificado
  (RIO-111 agrega la tabla `usuarios`/`asignaciones_rol` y el endpoint
  `whoami` que traduce ese email a rol/mercados/plan — eso no existe todavía
  acá, a propósito).
- `functions/_shared/response.js` para mantener el mismo formato de API en
  cualquier endpoint nuevo.
- Una migración nueva (`0003_...sql`) — nunca editar `0001`/`0002`.

**Riesgo #1 de RIO-97/RIO-108, todavía sin resolver (le corresponde a
RIO-111):** no duplicar `USER_MAP` de `users.js` en una segunda fuente
D1 desincronizada. Esta fundación no crea ninguna tabla de usuarios — a
propósito, para no adelantar esa decisión de diseño.
