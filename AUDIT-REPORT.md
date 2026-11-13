# AUDIT-REPORT — Perioshield S1–S7 (auditoría independiente profunda)

**Worktree:** `shield-deep-audit` · **Rama:** `audit/perioshield-s1-s7`
**Base del stack:** `ce7b459` (S1–S7 completo sobre baseline `087cc61`)
**Head auditado:** `4d301ad` (este commit + reporte queda encima)
**Auditor:** Devin (contexto adversarial independiente) + revisión externa puntual Codex `gpt-6.1-terra` (effort medium, worktree aislado `codex-order-recon`, rama `review/order-recon-codex`)

---

## 1. Alcance auditado

- **S1** `qualydataClient`, `detectionPoller` — cursor, dedupe `detections-seen`, HTTP/zod boundaries.
- **S2** `verificationEngine`, `measurePolicy` — motor puro, política por ISP, IP compartida -> dominio.
- **S3** `caseService`, `matchOrchestrator`, `persistence/` — expedientes, grafo de transiciones, auditoría append-only, fase_key.
- **S4** `shieldAuth` (JWT), `shiftGuard`, `signingService` (HMAC), `shieldRoutes`, `devServer`.
- **S5** `providerDispatcher`, `orderService`, `statusTracker`, `metricsService`, `collateralRisk`.
- **S6/S7** `shieldSocket`/`shieldRealtime` (autorización + sanitización) y consola React completa.
- **Transversal:** aislamiento tenant, secretos, boundary de datos simulados, realismo de tests, drift de migraciones.

## 2. Veredicto

**Stack APROBADO para integración tras las reparaciones aplicadas.** Se encontraron y corrigieron 3 defectos propios + 6 hallazgos de la revisión externa (4 reparados directamente, 2 mitigados con detección auditable por requerir decisión de dominio). Sin issues críticos/altos abiertos. Quedan 2 gaps de diseño documentados (§5.3-5.4) que requieren decisión de dominio — no son bloqueantes porque el fallo es *invisibilidad* del estado, no corrupción ni acción indebida.

## 3. Defectos encontrados por la auditoría propia (introducidos por S1–S7)

### 3.1 HIGH — `shield:e2e` configuraba una env var muerta → crash inmediato
- `scripts/shield-e2e.ts` fijaba `SHIELD_JWT_SECRET` pero `createShieldRuntime → requireJwtSecret()` lee `JWT_SECRET`. En cualquier entorno sin `JWT_SECRET` el e2e moría con `AuthConfigError` antes de tocar el simulador.
- **Fix:** `process.env.JWT_SECRET ??= "shield-e2e-demo-secret"` (commit `3f8addc`).

### 3.2 HIGH — Socket nunca conectaba tras login fresco (S7)
- `src/client/pages/shield/useShieldSocket.ts` tenía deps `[]` y leía el token solo en mount. El provider NO se remonta tras login → socket `null` para toda la sesión (polling fallback silencioso); en logout el socket autenticado quedaba vivo.
- **Fix:** hook recibe `juezId`, ciclo de vida atado a la sesión (commit `81bf054`) + test de regresión `useShieldSocket.test.tsx` (3 tests).

### 3.3 MEDIUM — Tracker hacía N GETs por ciclo → floods de ECONNREFUSED
- `statusTracker` polleaba cada orden viva individualmente; bajo el backlog de `ThreadingHTTPServer` en Windows producía ~1500 `cycle failed` transientes en el e2e.
- **Fix:** polling por lote `GET /proveedores/<id>/ordenes` por proveedor + fallback por orden (commit `4e6f8b2`) + tests batch/fallback.

### 3.4 LOW — `shield:judge-flow` ensuciaba el repo con tmpdirs
- `fs.mkdtemp("judge-flow-")` creaba datos dentro del worktree. Ahora `os.tmpdir()` con prefijo `shield-judge-flow-` (commit `3f8addc`).

## 4. Revisión externa delegada (Codex gpt-6.1-terra, medium)

**Pregunta delegada (única, acotada):** máquina de reconciliación de órdenes entre `providerDispatcher` y `statusTracker` — interleavings de ciclos, retries, 409 y reinicios.
**Ejecución:** worktree Orca nuevo `codex-order-recon` sobre `audit/perioshield-s1-s7` @ `cce277a`, modelo `gpt-6.1-terra` + effort medium (verificado en TUI), read-only, sin tests/push/red. Reporte: `CODEX-REVIEW-FINDINGS.md` en ese worktree (no integrado a esta rama — artefacto de revisión).

**Validación independiente de cada claim (todos confirmados contra fuente):**

| # | Claim Codex | Validación | Estado |
|---|---|---|---|
| C1 | HIGH: tracker reencola `enviada` con POST en vuelo → POST duplicado + regresión de estado | `statusTracker.ts` reencolaba todo `enviada` remoto-ausente sin margen; dispatcher guarda `enviada` **antes** del POST | **REPARADO** `4d301ad` — gracia `enviadaRequeueGraceMin` (default 2 min-sim) + guard de reentrada en `cycleOnce` (tracker y dispatcher) |
| C2 | HIGH: HTTP 5xx persistido como rechazo definitivo | `providerDispatcher.ts` enviaba todo `SimulatorHttpError` ≠409 a `reject()` final | **REPARADO** `4d301ad` — 5xx queda `enviada` (ambiguo), el tracker adopta verdad remota o reencola |
| C3 | HIGH: expediente con todas las medidas en fallo terminal nunca termina | `aggregateTarget` devuelve `null` cuando todo slot es `terminal_fail`; el grafo no tiene borde a un terminal de fallo | **GAP DE DOMINIO** — mitigado con auditoría única `expediente_sin_borde_terminal`; requiere decisión de grafo (nuevo estado) — ver §5.3 |
| C4 | HIGH: crash mid-approval deja expediente aprobado con 0/N órdenes irrepetibles | `orderService.approve` persiste la transición antes de componer/guardar órdenes; JSON store no tiene transacciones | **MITIGADO** `4d301ad` — auditoría única `expediente_ordenes_incompletas` (presentes vs medidas firmables); atomicidad real requiere cambio de persistencia — ver §5.4 |
| C5 | MEDIUM: una fila inválida en el listado por lote congela todo el proveedor | `ordenes()` hace `schema.parse` del array completo → catch saltaba todas las órdenes del ISP | **REPARADO** `4d301ad` — fallback por orden ante fallo del lote |
| C6 | MEDIUM: retry firmado con reloj del partido nuevo si cambió el match | `resolveRetry` usaba `estado.fin_min` actual sin verificar `expediente.partido_id` vs `estado.partido` | **REPARADO** `4d301ad` — `bloquear("partido_distinto_del_expediente")` |

Codex también verificó sin defecto: mapeo de estados proveedor→local (`recibida` nunca se trata como `aplicada`), mapeo batch por `orden_id`, ausencia de retry directo tras `aplicada`/`vencida`/rechazo, y adopción post-crash de verdad remota.

## 5. Aspectos verificados limpios

- **Autorización:** solo `POST /api/shield/auth/login` público; todo lo demás bajo `requireJudge`. Aprobación/rechazo re-lee reloj del simulador, verifica turno **y** asignación server-side (`can_sign` del front es solo hint). Match finalizado bloquea firma. Intentos fallidos auditados.
- **Socket.IO:** JWT inválido/ausente/no-juez rechazado; solo sockets autenticados entran a la sala `shield`. Payload sanitizado (firma truncada a 12 chars, claves tipo-secreto eliminadas).
- **HMAC:** firma real verificada por el fake provider en tests y por el simulador real en e2e (judge-flow: `firma_verificada=true`; sim log: 92/92 `juez_de_turno:true`).
- **Idempotencia:** retry crea `orden_id` nuevo `-NN` + firma nueva del MISMO juez en turno; 409 adopta verdad remota; reinicio no duplica envíos ni reintentos (test dedicado).
- **Boundary simulado:** banner visible en todas las vistas; `data/shield` gitignored; sim log separado.
- **fase_key:** re-detección de misma fase consolida; cambio de infra crea expediente nuevo (spec-correcto).
- **Terminalidad `descartado`:** verificada como sink sin aristas.

## 5.3 Gap de dominio 1 — sin borde terminal para "todo falló"
Cuando todas las medidas de un expediente terminan en fallo definitivo (rechazo proveedor, `fallida` final, hold local), el grafo `TRANSICIONES_EXPEDIENTE` no ofrece estado terminal honesto y `aggregateTarget` devuelve `null` → expediente queda `aprobado`/`distribuyendo`/`parcial` para siempre. **Reparación aplicada:** evento auditado `expediente_sin_borde_terminal` (una vez por expediente) que hace visible el hueco. **Pendiente de dominio:** definir estado terminal (p.ej. `fallido`/`sin_efecto`) y su arista — no se inventó semántica nueva en esta auditoría.

## 5.4 Gap de dominio 2 — atomicidad approval→órdenes
`orderService.approve` persiste la transición a `aprobado` antes de componer/guardar órdenes; un crash en el medio deja un expediente aprobado con 0 órdenes (o subconjunto) que no puede re-aprobarse ni reconstruirse. Ordenar al revés es peor (el dispatcher enviaría órdenes de un caso aún pendiente). **Reparación aplicada:** `expediente_ordenes_incompletas` auditado una vez por expediente. **Pendiente de dominio:** transaccionalidad real en el store o recomposición idempotente en recovery.

## 6. Hallazgos pre-existentes (baseline, NO introducidos por S1–S7)

- `drizzle/0004_rainy_doctor_doom.sql`, `drizzle/meta/0004_snapshot.json` sin trackear + `drizzle/meta/_journal.json` modificado: drift de migración del schema editorial que ya existe en `main`; el build `drizzle-kit generate` lo regenera. **Excluido deliberadamente de los commits.**
- `tsconfig.json` raíz sin `--jsx`: el cliente se verifica con `vite build`, no con `tsc` raíz. Pre-existente.
- Warning de chunk >1.6 MB en el build de Vite: pre-existente del bundle editorial.

## 7. Observaciones transitorias (no defectos)

- `ECONNREFUSED` intermitentes del simulador Python bajo ráfagas (backlog de `ThreadingHTTPServer` en Windows): el tracker los loguea vía `onError` y los ciclos se recuperan. La reparación por lote redujo la superficie ~orden-de-magnitud; en el e2e final los errores residuales son transitorios y autorecuperables.

## 8. Gates ejecutados (exit codes reales, corridas finales sobre el head con reparaciones)

| Gate | Resultado | Evidencia |
|---|---|---|
| `npm test` | **exit 0** — 20 archivos, 132 tests | incluye 6 tests nuevos de reconciliación |
| `npm run build:server` | **exit 0** | tsc server limpio |
| `npm run build` | **exit 0** | client + server + drizzle-kit |
| `shield:smoke` | **exit 0** | sim `practica-01` 6x, poller OK |
| `shield:judge-flow` | **exit 0** | login 200, approve 200, firma_verificada=true, OUT_OF_SHIFT 403 correcto, 1 orden persistida |
| `shield-ui-smoke` | **exit 0** | health, JWT, socket auth-reject/auth-ok, UI shell |
| `shield:e2e` | **exit 0** — "E2E OK — todos los chequeos S5 pasaron" | corrida final completa post-reparaciones, partido fresco `practica-01` 6x |

## 9. Estado e2e — corrida final (post-reparaciones, exit 0 capturado)

- 7 aprobaciones reales por API con rotación de turno correcta (Laura min 2-37, Martín min 55-82).
- 32 órdenes: 28 `vencida` (todas alcanzaron `aplicada` primero) + 4 `fallida` finales; 4 retries cumbre deterministas emitidos con sufijo `-NN` y firma nueva.
- Aserciones: `>=3 ISPs con aplicada` (4: aurora/andina/valle/cumbre), IPs compartidas solo dominio, valle solo dominio, sim log **92/92 `juez_de_turno:true`**, cero IP activa post-gracia local **y** remota, grace check ejecutado.
- `cobertura alcanzada ponderada = 100.0%`. Todos los expedientes terminaron `vencido`.
- **Zero `cycle failed` en toda la corrida** (vs ~1534 transitorios pre-batch-fix) — la reparación por lote eliminó la superficie de ECONNREFUSED.
- Corrida previa (pre-reparaciones): también completó; aserciones recomputadas VERDES desde artefactos.

## 10. UX/UI — auditoría y elevación (commit `815e96e`)

- Primitivas compartidas: `ShieldCard`, `SkeletonRows`, `StaleWarning`, `StatCard`, badges con status-dot, firma truncada, enmascarado de valores de auditoría (`/firma|clave|password|secret|token|b64|sha/i`).
- Accesibilidad: `role=status`/`aria-live` en loading, `role=alert` en errores, labels `htmlFor`/ids en login, focus-visible rings, numerales tabulares.
- Accionabilidad: bandeja reordena casos firmables primero + contador; estados stale/error/skeleton en monitor, métricas y detalle.
- Dominio intacto: `recibida` jamás renderizada como `aplicada`; sin features inventados; banner de entorno simulado en todas las vistas.

## 11. Commits del audit (convencionales, paths explícitos, sin -A)

```
4d301ad fix(shield): reconcile dispatch/tracker races and terminal-state gaps
cce277a chore(shield): wire shield-ui-smoke into package scripts
815e96e feat(shield-ui): elevate judicial console UX and accessibility
4e6f8b2 fix(shield): tracker polls provider order lists in batch
81bf054 fix(shield-client): socket lifecycle follows the signed-in judge
3f8addc fix(shield-scripts): e2e reads JWT_SECRET, judge-flow uses os tmpdir
```

## 12. Recomendación de integración (para Hermes)

1. Mergear `audit/perioshield-s1-s7` @ `<HEAD>` en el worktree de integración dedicado.
2. Re-correr gates allí (test/build:server/build + sim gates con un partido fresco).
3. **Decisión de dominio pendiente** antes de producción real: estado terminal para "todas las medidas fallaron" (§5.3) y atomicidad approval→órdenes (§5.4). Ambos ya son observables vía auditoría.
4. Conservar `data/shield`, signing keys y kit del simulador como material gitignored local (como hoy).
5. No mergear el drift `drizzle/0004_*` — pertenece al schema editorial, no al stack shield.
