-- RIO-117 (segundo bloque) — Migración 0019
-- Integra el botón "Cerrar venta" del Kit Comercial con el registro real
-- en D1 — hoy solo enviaba un formulario a HubSpot y la operación nunca
-- aparecía en el Panel del Vendedor. Brenda confirmó (31/08/2026):
-- "el vendedor no debe volver a ingresar en el panel los datos que ya
-- completó durante la venta".
--
-- `idempotency_key`: una sola acción de "Cerrar venta" — con clics
-- repetidos, timeouts o recargas — nunca crea más de una venta. Índice
-- ÚNICO PARCIAL (solo sobre filas con clave no nula) para no romper las
-- ventas existentes ni las que se sigan creando sin pasar por el Kit
-- (ej. una futura integración distinta) — todas esas conviven con NULL.
--
-- `origen`: de dónde vino el registro ('kit_comercial' | NULL para
-- cualquier otro camino de creación) — dato estructurado, no una nota de
-- texto, tal como pidió Brenda explícitamente.
--
-- `es_demo`: datos ficticios de Preview para que Brenda valide el panel
-- con todos los estados posibles, sin que puedan llegar a Producción,
-- sincronizarse con HubSpot ni generar una liquidación real. Ver
-- 0020_datos_demo_preview.sql para la siembra.
ALTER TABLE ventas ADD COLUMN idempotency_key TEXT;
ALTER TABLE ventas ADD COLUMN origen TEXT;
ALTER TABLE ventas ADD COLUMN es_demo INTEGER NOT NULL DEFAULT 0 CHECK (es_demo IN (0, 1));
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_idempotency_key ON ventas (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Registro de sincronización con HubSpot — RIO-117 implementa acá
-- únicamente el CONTRATO y el registro necesarios para que "Cerrar venta"
-- funcione de punta a punta: D1 primero (fuente de verdad operativa),
-- HubSpot después, nunca dos escrituras independientes sin control desde
-- el navegador. La integración SEGURA server-to-server (token privado del
-- Worker, asociación real de objetos, reintento administrado) es RIO-120,
-- todavía no iniciada — ver la nota de alcance en el código
-- (functions/_shared/hubspot.js) y en RIO-117/RIO-120 en Notion. Mientras
-- tanto, se reutiliza el mismo endpoint público de HubSpot Forms API que
-- el Kit ya usaba desde el navegador (portalId/formGuid no son secretos:
-- ya viajaban visibles en el HTML del Kit) — ahora se llama desde el
-- Worker, después de que D1 ya tiene la venta guardada, nunca antes.
CREATE TABLE IF NOT EXISTS hubspot_sync (
  id TEXT PRIMARY KEY,
  venta_id TEXT NOT NULL REFERENCES ventas(id),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'exitoso', 'fallido')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultima_respuesta_resumen TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hubspot_sync_venta ON hubspot_sync (venta_id);
CREATE INDEX IF NOT EXISTS idx_hubspot_sync_estado ON hubspot_sync (estado);
