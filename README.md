# PeriodistApp Shield · Bloqueo Preciso Federal

**Hackathon Argentina Space 2026** · Track Streaming / QualyData · 11–13/11/2026

> **ENTORNO SIMULADO / DATOS FICTICIOS.** Todos los casos, usuarios judiciales, dominios, direcciones IP, ASN, proveedores y órdenes de este repositorio son ficticios. La plataforma opera **únicamente contra el simulador oficial de QualyData** ([`qualydata-org/desafio-futbol`](https://github.com/qualydata-org/desafio-futbol)). No rastrea, descarga, bloquea ni denuncia infraestructura real. No es asesoramiento jurídico.

MVP de una **plataforma federal simulada de verificación de retransmisiones futbolísticas no autorizadas y órdenes judiciales de bloqueo en vivo**. Construido sobre componentes reutilizados de [PeriodistApp-6.0](https://github.com/adriangmrraa/PeriodistApp-6.0) — ver [Declaración de código preexistente](docs/codigo-preexistente.md).

## Qué hace

```
Simulador QualyData → Detecciones → Verificación de evidencia (SHA-256)
→ Clasificación (pirata / licenciatario / otra señal) → Expediente digital
→ Juez autenticado + control de turno → Firma HMAC → Órdenes por ISP
→ Confirmación / reintentos → Vencimiento al fin del partido → Auditoría + exportación
```

Principios de diseño: ninguna detección se convierte automáticamente en orden — requiere aprobación explícita de un juez de turno; nunca se bloquea por IP sobre infraestructura compartida/CDN cuando hay riesgo de daño colateral; todo queda auditado.

## Requisitos

- Node.js >= 20 · npm >= 10
- Python 3.10+ (solo para el simulador/evaluador oficial)
- PostgreSQL (Neon) o SQLite/JSONL local — ver `DATABASE_URL` en `.env.example`

## Quickstart

### 1. Simulador oficial (terminal 1)

El simulador se clona por separado en `tools/desafio-futbol` (no forma parte de este repo):

```bash
git clone https://github.com/qualydata-org/desafio-futbol tools/desafio-futbol
cd tools/desafio-futbol && mkdir -p salida

# Linux / macOS
python simulador/servidor.py --escenario datos/escenario_practica.json --acelerar 6 --puerto 8080 --log salida/registro.jsonl

# Windows (Git Bash) — requiere UTF-8 por caracteres no-ASCII del servidor
PYTHONUTF8=1 python simulador/servidor.py --escenario datos/escenario_practica.json --acelerar 6 --puerto 8080 --log salida/registro.jsonl
```

Verificación: `curl http://localhost:8080/estado` debe devolver `minuto_actual`, `fin_min` y `jueces_de_turno`.

### 2. App (terminal 2)

```bash
cp .env.example .env   # completar valores
npm install
npm run dev            # Express + Vite (socket.io incluido)
```

La app **no** depende de APIs de IA, redes sociales, yt-dlp, FFmpeg ni suscripciones pagas para el modo `SHIELD_MODE=simulator`.

### 3. Evaluador oficial (al terminar el partido + 5 min de gracia)

```bash
cd tools/desafio-futbol
python evaluacion/verificar.py --log salida/registro.jsonl
```

> El log del simulador **se sobreescribe en cada corrida**: copiar a `salida/artefactos/` antes de reiniciar.

## Configuración

Ver `.env.example`. Claves principales:

| Variable | Descripción |
|---|---|
| `SIMULATOR_BASE_URL` | URL del simulador (práctica o final). **Cambiar entre escenarios sin tocar código.** |
| `SHIELD_MODE` | `simulator` (único modo soportado) |
| `DATABASE_URL` | Postgres/Neon; opción local documentada abajo |
| `JWT_SECRET` | Secreto de sesión del prototipo |
| `SHIELD_SIGNING_KEYS_PATH` | Ruta al JSON con claves de firma DEMO de jueces (solo servidor, jamás en frontend ni exports) |
| `PORT` / `FRONTEND_URL` | Servidor y CORS |

## Estructura

```
src/server/shield/        # Núcleo del MVP (cliente API, evidencia, juez, firma, ISP, auditoría)
src/client/pages/shield/  # Vistas: Centro de ops, Caso/evidencia, Bandeja juez, Monitor ISP
docs/                     # Arquitectura y declaración de código preexistente
entrega/                  # Entregables Hacki: expediente ejemplo, auditoría, propuesta normativa, métricas
tools/desafio-futbol/     # Simulador oficial QualyData (repo separado, NO modificar)
salida/artefactos/        # Copias preservadas de logs/evaluaciones por corrida
```

## Reglas del proyecto

- **Nunca** aprobar órdenes automáticamente a nombre del juez; la demo usa cuentas ficticias con operador humano.
- **Nunca** commitear secretos, claves de firma, credenciales ni el brief privado.
- **Nunca** modificar `tools/desafio-futbol` para mejorar puntuación.
- No lanzar múltiples polling loops simultáneos sobre el mismo simulador.

## Entregables (Hacki)

- [ ] Repo público con README y código
- [ ] `entrega/expediente-ejemplo.json` + `entrega/auditoria-final.jsonl`
- [ ] `entrega/propuesta-normativa.md` (1 página)
- [ ] `entrega/metricas-evaluacion.json` (salida real del verificador)
- [ ] Video demo ≤ 3 min (enlace público)
- [ ] URL de aplicación desplegada
