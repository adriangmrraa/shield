# Arquitectura — PeriodistApp Shield

> Estado: **borrador inicial** (P0). Se actualiza a medida que aterriza cada fase.

## Flujo principal

```
Simulador QualyData (HTTP REST)
  → QualyDataClient → DetectionPoller (cursor por minuto_actual)
  → EvidenceVerifier (SHA-256 de captura) → RiskClassifier (marca/licencia/ASN)
  → CaseRepository → JudgeInbox (login + ShiftGuard)
  → OrderComposer + HMACSigner → ISPDispatcher + StatusTracker (reintentos)
  → ExpiryWatcher (vence_min = fin_min) → AuditTrail (append-only) → Exporter
  → Dashboard React vía /api/shield/* + Socket.IO
```

## Capas (SOLID, §22 del brief)

- `domain/` — tipos de la API oficial (`SimulatorState`, `Detection`, `Provider`, `BlockOrder`…), reglas e invariantes puras. Sin imports de Express/Drizzle/Axios.
- `application/` — casos de uso (clasificar detección, preparar expediente, aprobar/rechazar, despachar órdenes, procesar reclamos).
- `infrastructure/` — `HttpSimulatorClient`, persistencia (Drizzle o adaptador local), `HMACSigner`, reloj del simulador.
- `presentation/` — rutas `/api/shield/*`, eventos `shield:*` por Socket.IO, páginas React.

`FakeSimulatorClient` e `HttpSimulatorClient` cumplen el mismo contrato (LSP) para tests deterministas sin servidor.

## Contratos críticos del simulador

- **Reloj canónico**: `minuto_actual` de `GET /estado`, nunca la hora local. Cursor de `/detecciones?desde=` arranca en `-1` y avanza con el `minuto_actual` devuelto.
- **Firma de orden**: `HMAC_SHA256_HEX(clave_juez, orden_id|tipo|objetivo|vence_min|juez_id)`, hex minúscula UTF-8.
- **Firma de levantamiento**: `HMAC_SHA256_HEX(clave, 'LEVANTAR|' + orden_id + '|' + juez_id)`.
- `vence_min` entero y posterior al minuto actual (normalmente `fin_min`); `202 recibida` ≠ aplicada — hay que pollar estado.
- Reintento de orden fallida = **nuevo** `orden_id` + nueva firma (el simulador responde 409 a IDs duplicados).

## Persistencia

Drizzle + Postgres si conecta sin fricción; si Neon bloquea la demo local, adaptador local (SQLite/JSONL) detrás de las mismas interfaces de repositorio. Tablas `shield_*` separadas de las tablas editoriales de PeriodistApp.

## Invariantes

1. Ninguna detección se convierte automáticamente en orden — siempre juez autenticado y de turno.
2. Nunca bloqueo por IP sobre IP compartida/CDN con dominios legítimos — preferir dominio.
3. Nunca firmar fuera de turno — verificar dos veces (render + ejecución).
4. Claves de firma DEMO solo en servidor; jamás en frontend/exports.
5. Toda decisión, rechazo, fallo y limitación queda auditado.
