# Worker: reevaluación automática de comisiones vencidas

**Estado: Preview desplegado desde RIO-122; Production, RIO-123 (28/09/2026).**
Creado en RIO-122 (15/09/2026) para resolver que una comisión podía quedar en
`calculada_provisional` para siempre si, después de cumplirse el plazo de
resguardo, no ocurría ningún otro evento sobre la venta (un pago
acreditándose, una disputa resolviéndose) que volviera a disparar
`evaluateComisionGate()`.

## Qué hace

Cada día (`0 12 * * *`, configurable en `wrangler.toml`), llama a
`reevaluarComisionesVencidasDelSistema()`
(`functions/_shared/comisiones.js`), que:

1. Busca todas las comisiones en `calculada_provisional` o `retenida`.
2. Para cada una, ejecuta `evaluateComisionGate()` — **la misma función que
   ya usa el resto del sistema**, nunca una segunda implementación del
   gate ni un cálculo de fecha propio.
3. Si las 3 condiciones (plazo de resguardo cumplido, pago total
   acreditado, sin disputa abierta) más el resto de condiciones existentes
   ya se cumplen, la comisión pasa a `habilitada` y luego a `programada`
   con su `fecha_programada` calculada por `calcularFechaProgramada()`
   (sin tocar) — cada transición queda en `eventos_historial`, igual que
   cualquier otro cambio de estado del sistema.

Idempotente: correrlo muchas veces seguidas (o el cron + una corrida
manual el mismo día) nunca duplica un evento ni reprograma una fecha ya
establecida — cada comisión que ya avanzó de estado queda fuera del
barrido siguiente.

## Por qué un Worker aparte

Cloudflare Pages Functions (el proyecto principal, `rio-impulso-digital`)
solo responden a solicitudes HTTP — no soportan un disparador programado
(`scheduled()`), que es exclusivo de Workers. La alternativa de exponer un
endpoint HTTP dentro de `/interno/api/*` para que un cron externo lo
llamara habría exigido sortear a Cloudflare Access (el middleware de
`/interno/api/*` exige un JWT humano válido) con un token de servicio de
Zero Trust — algo que Anthy no tiene permisos para configurar (ver
`ANTHY.md`). Conectar este Worker directo al mismo binding D1 evita ese
problema por completo: nunca hay una ruta pública nueva que proteger.

## Activación — Preview (ya hecha en RIO-122/123)

1. **Secreto**: `wrangler secret put MANUAL_TRIGGER_SECRET --config workers/comisiones-cron/wrangler.toml`
   (protege únicamente el `POST` manual de verificación de abajo — el cron
   programado no lo necesita).
2. **Desplegar**: `npx wrangler deploy --config workers/comisiones-cron/wrangler.toml`
   (sin `--env`: usa la sección de nivel superior — `rio-comisiones-cron-preview`,
   apuntando a `rio-ventas-preview`).
3. **Verificar manualmente una vez** (opcional, recomendado antes de
   confiar en el cron):
   ```
   curl -X POST https://rio-comisiones-cron-preview.<tu-subdominio>.workers.dev \
     -H "X-Manual-Trigger-Secret: <el secreto del paso 1>"
   ```
   Debe responder `{"ok":true,"requestId":"manual-...","evaluadas":N,"habilitadas":M}`.
4. **Confirmar el disparo programado**: Cloudflare Dashboard → Workers &
   Pages → `rio-comisiones-cron-preview` → Triggers, o `wrangler tail
   --config workers/comisiones-cron/wrangler.toml` durante una ejecución
   real del cron.

## Activación — Production (RIO-123)

**Nunca reapuntar el Worker de Preview** — Production es un Worker propio
(`rio-comisiones-cron`), declarado en `[env.production]` de este mismo
`wrangler.toml`, apuntando exclusivamente a `rio-ventas-prod`
(`tests/worker-comisiones-cron-config.test.js` protege que no se mezclen).

1. **Secreto propio de Production** (nunca reutilizar el valor de Preview):
   `wrangler secret put MANUAL_TRIGGER_SECRET --config workers/comisiones-cron/wrangler.toml --env production`
2. **Desplegar**: `npx wrangler deploy --config workers/comisiones-cron/wrangler.toml --env production`
   — crea el Worker `rio-comisiones-cron` y activa su Cron Trigger.
3. **Verificar manualmente una vez** contra el subdominio de ESE Worker
   (`rio-comisiones-cron`, no `-preview`):
   ```
   curl -X POST https://rio-comisiones-cron.<tu-subdominio>.workers.dev \
     -H "X-Manual-Trigger-Secret: <el secreto de Production>"
   ```
   Debe responder `{"ok":true,"requestId":"manual-...","evaluadas":N,"habilitadas":M}`,
   con `evaluadas`/`habilitadas` coherentes contra
   `SELECT estado, COUNT(*) FROM comisiones GROUP BY estado` en `rio-ventas-prod`
   (consulta de solo lectura) — nunca contra Preview.
4. **Confirmar el disparo programado**: Cloudflare Dashboard → Workers &
   Pages → `rio-comisiones-cron` → Triggers, o
   `wrangler tail --config workers/comisiones-cron/wrangler.toml --env production`
   durante una ejecución real del cron.
