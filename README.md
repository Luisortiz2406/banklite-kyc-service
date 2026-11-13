# KYC Service (`kyc-service`)

[![Despliegue](https://github.com/Luisortiz2406/banklite-kyc-service/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Luisortiz2406/banklite-kyc-service/actions/workflows/deploy.yml)

Verificación de identidad (Know Your Customer) con Verifik y custodia cifrada de los datos personales.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Recibe los datos personales del registro, los valida contra **Verifik** (cédula y
antecedentes) y emite `identity.verified` o `identity.rejected`. Guarda documento,
fechas y teléfono **cifrados con AES-256** e índices ciegos (HMAC) para buscarlos sin
descifrar. Ningún otro servicio lee esta base: auth y account preguntan por HTTP o
escuchan los eventos.

**Reglas de negocio principales**

- Mayor de edad, documento vigente, fecha de expedición coherente y nombre igual al registrado.
- Cada rechazo guarda un `rejection_code`. Los rechazos por validaciones fallidas o datos que no coinciden se pueden aprobar a mano (rol `compliance` o `admin`); los de **reglas duras** (menor de edad, documento no vigente, antecedentes pendientes, fecha de expedición inválida) nunca.
- Un empleado no puede aprobar su propia verificación; abrir la ficha completa queda en la auditoría.
- Documento y teléfono únicos (por índice ciego).

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | `identity.verified` → account, compliance<br>`identity.rejected` → notification, compliance<br>`identity.email_confirmed` → notification |
| Consume eventos | — |
| Llama a | — |
| Lo llaman | auth-service: `GET /kyc/status/:id_user` y `PATCH /kyc/contact`<br>api-gateway (rutas `/kyc/*`) |
| Integraciones externas | Verifik (consulta de cédula y antecedentes); modo `demo` para pruebas |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/kyc`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`kyc_db`)

| Tabla | Contenido |
|---|---|
| `kyc_records` | Datos personales cifrados, estado, motivo de rechazo y revisión manual. |
| `event_outbox` | Outbox de eventos. |
| `admin_audit` | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb kyc_db
psql "postgres://usuario:clave@localhost:5432/kyc_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-kyc-service .
docker run --env-file .env -p 3003:3003 banklite-kyc-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3003/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/kyc/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |
| POST | `/kyc/submit` | Envía los datos personales del registro y dispara la verificación. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/kyc/:id_user` | Datos de identidad del propio cliente. |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/kyc/admin/records` | cualquier empleado | Lista de verificaciones (datos enmascarados). |
| GET | `/kyc/admin/records/:idUser/resumen` | cualquier empleado | Resumen de una verificación. |
| GET | `/kyc/admin/records/:idUser` | compliance, admin | Ficha completa descifrada (queda en la auditoría). |
| POST | `/kyc/admin/records/:idUser/approve` | compliance, admin | Aprobación manual de un rechazo aprobable. |
| GET | `/kyc/admin/outbox` | cualquier empleado | Eventos del outbox (pendientes y publicados). |
| GET | `/kyc/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| PATCH | `/kyc/contact` | Actualiza correo/teléfono verificados (auth-service). |
| GET | `/kyc/status/:id_user` | ¿La identidad está verificada? (auth-service). |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3003` | Puerto HTTP del servicio. |
| `METRICS_PORT` | No | `9100` | Puerto de `GET /metrics` (Prometheus), solo para la red privada; **no** es el puerto público (`PORT`). `off` lo apaga. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://kyc_svc:<DB_PASSWORD_KYC>@localhost:5432/kyc_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `KYC_ENCRYPTION_KEY` | **Sí** (no arranca sin ella) | — | Llave AES-256 (64 hex) de los datos personales cifrados. |
| `INTERNAL_TRUSTED_KEYS` | **Sí** (no arranca sin ella) | `auth:<clave-de-auth>` | Claves internas que acepta, `servicio:clave,servicio:clave` (ver `InternalKeyGuard`). |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `VERIFIK_MODE` | No | `demo` | `live` (API de Verifik) o `demo` (validación local para pruebas). |
| `VERIFIK_API_KEY` | No | — | Token de Verifik (obligatorio con `VERIFIK_MODE=live`). |
| `VERIFIK_API_URL` | No | `https://api.verifik.co/v2/co/cedula` | Endpoint de consulta de cédula en Verifik. |
| `VERIFIK_ANTECEDENTES_MODE` | No | — | Consulta de antecedentes: `live` o `demo` (si falta, usa `VERIFIK_MODE`). |
| `VERIFIK_ANTECEDENTES_URL` | No | `https://api.verifik.co/v2/co/policia/consultar` | Endpoint de antecedentes en Verifik. |
| `VERIFIK_AUTH_SCHEME` | No | `jwt` | Esquema del encabezado Authorization para Verifik. |
| `VERIFIK_SKIP_NAME_CHECK` | No | `false` | Solo pruebas: no comparar el nombre con el registrado. |

## Cifrado de datos existentes

Al arrancar, el contenedor corre `scripts/encrypt-kyc-fields.js`, que cifra las filas que
estén en claro (por ejemplo, las de `database/seed.sql`) y llena los índices ciegos.
## Pruebas

```bash
npm test
```

Se prueba el flujo de verificación de identidad (`kyc.service.spec.ts`: aprobada y rechazada, menor de edad y expedición inválida, unicidad de documento y teléfono, token de envío), la integración con Verifik en modo demo y live con `fetch` simulado (`verifik.service.spec.ts`; nunca se llama al proveedor real), las reglas duras de rechazo, el cifrado de datos de identidad, el outbox de eventos, los controladores, los guards, `/health` y la validación de configuración. Las pruebas de este servicio no necesitan base de datos.

**Cobertura:** el pipeline la muestra en el resumen de cada corrida y exige un mínimo de 70 % de líneas y 50 % de ramas (`umbral-lineas` y `umbral-ramas` en `deploy.yml`). Hoy está en 93,8 % de líneas y 90,4 % de ramas.

## Despliegue

Lo despliega **GitHub Actions** (`.github/workflows/deploy.yml`, que usa el workflow
reutilizable de [banklite-pipelines](https://github.com/Luisortiz2406/banklite-pipelines)):

1. **test**: lint, formato, build y pruebas (también en cada pull request).
2. **docker** (solo `main`): imagen en GHCR `ghcr.io/luisortiz2406/banklite-kyc-service`,
   etiquetada con el SHA del commit y `latest` (se guardan las últimas 5).
3. **deploy** (solo `main`): `railway up --ci` sube el commit a Railway, que lo
   construye con el `Dockerfile` y aplica `railway.json` (health check en `/health`);
   el job espera a que el despliegue quede activo.

El repositorio está desconectado del autodeploy de Railway: un push a `main` despliega
solo a través de este pipeline, y únicamente si las pruebas pasan. Rollback: panel de
Railway → *Deployments* → versión anterior → *Rollback*. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `kyc-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/kyc/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Lo llama:** estado de identidad y contacto verificado |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Envía:** `identity.verified` |
| [banklite-notification-service](https://github.com/Luisortiz2406/banklite-notification-service) | **Envía:** `identity.rejected`, `identity.email_confirmed` |
| [banklite-compliance-service](https://github.com/Luisortiz2406/banklite-compliance-service) | **Envía:** `identity.verified`, `identity.rejected` |
| [banklite-rewards-service](https://github.com/Luisortiz2406/banklite-rewards-service) | **Lo llama:** nombre del cliente |
