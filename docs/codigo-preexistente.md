# Declaración de código preexistente

La consigna del hackathon exige trabajo original realizado durante la competencia (11–13/11/2026) y permite código previo declarado. Este documento es la trazabilidad oficial del proyecto.

## Base importada

| | |
|---|---|
| Repositorio origen | https://github.com/adriangmrraa/PeriodistApp-6.0 |
| Rama | `master` |
| **SHA base** | `78c35360f77f5df22cd25993ac79481f0ed28a1b` |
| Commit base | `docs: premium banner with Fusa Labs branding and corporate aesthetic` |
| Fecha de importación | 2026-11-12 |
| Mecanismo | `git remote add upstream` + `reset --hard upstream/master` — historial completo preservado |

**Todo commit anterior al SHA base es código preexistente del titular**, no desarrollado durante el hackathon. Todo commit posterior es trabajo nuevo de la competencia.

## Componentes reutilizados (según auditoría del brief)

- Servidor HTTP Express + Socket.IO (`src/server/index.ts`)
- Auth JWT (`src/server/middleware/auth.ts`) — base, NO los roles editoriales
- Drizzle ORM + esquema (`src/server/db/`)
- React 19 + Tailwind + componentes UI (`src/client/`)
- Patrones de bandeja/revisión y pipeline (`src/server/services/`, `src/server/routes/review.ts`)

## Componentes desconectados en el MVP

Extracción/descarga de streams, transcripción, diarización, publicación en redes, generación de notas/clips/flyers, IA generativa, billing (Stripe/MercadoPago), suscripciones. La ruta `src/server/routes/pipeline.ts` protegida por `requireActiveSubscription` **no se reutiliza** — las rutas nuevas viven bajo `/api/shield/*`.

## Herramientas externas (no parte del código entregado)

| Herramienta | Origen | SHA al clonar | Uso |
|---|---|---|---|
| Simulador + evaluador QualyData | `qualydata-org/desafio-futbol` | `96d3db5d86fa55ca0ac38fdd684e07b17e4e930b` | Fuente canónica de detecciones, órdenes y métricas. **Sin modificaciones.** |
