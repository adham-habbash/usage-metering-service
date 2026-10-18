# Usage Metering Service

A TypeScript REST API for managing usage plans, enforcing monthly account and user limits, and recording usage decisions in PostgreSQL.

## Features

- REST API built with TypeScript and Express.
- PostgreSQL persistence.
- Configurable account-level and user-level plans.
- Monthly usage limits and per-request unit limits.
- Usage consumption decisions with request history.
- Request idempotency using request IDs.
- Input validation and centralized error handling.
- Docker Compose support.
- Automated tests, linting, type checking, and build verification.
- GitHub Actions continuous integration.

## Technology Stack

- Node.js and TypeScript
- Express
- PostgreSQL
- Docker and Docker Compose
- Vitest
- Zod

## Prerequisites

- Node.js and npm
- Docker with Docker Compose
- Git

## Setup

Clone the repository and enter the project directory:

```bash
git clone https://github.com/adham-habbash/usage-metering-service.git
cd usage-metering-service
```

Install dependencies:

```bash
npm ci
```

Create the local environment file:

```bash
cp .env.example .env
```

Review `.env` and make sure its database settings match `compose.yaml`.

Start the services:

```bash
docker compose up --build -d
```

Check the service status and logs:

```bash
docker compose ps
docker compose logs -f api
```

## Development Commands

Run each check separately:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## API Overview

The API uses JSON request and response bodies.

### Health

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Check application health |
| GET | `/health/ready` | Check readiness |
| GET | `/` | Open the demo page |

### Accounts

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/accounts` | Create an account |
| GET | `/api/account` | Get the authenticated account |
| PATCH | `/api/account/plan` | Change the account plan |

Creating an account does not require an API key. The response includes an API key. Save it securely because it is not returned again.

Example:

```bash
curl -X POST http://localhost:8080/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"Example Account"}'
```

Use the returned API key for protected endpoints:

```bash
curl http://localhost:8080/api/account \
  -H "X-API-Key: YOUR_API_KEY"
```

Replace `YOUR_API_KEY` with the actual key returned when you created the account.

### Plans

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/plans` | List available plans |
| POST | `/api/plans` | Create a plan |
| PATCH | `/api/plans/:planId` | Update a plan |

Protected endpoints require the `X-API-Key` header.

Example plan request:

```json
{
  "name": "Custom User Plan",
  "scope": "user",
  "monthlyAllowance": 1000,
  "maxUnitsPerRequest": 100
}
```

Send this JSON to `POST /api/plans` with the `Content-Type: application/json` and `X-API-Key` headers.

The `scope` is either `account` or `user`. The per-request limit must not exceed the monthly allowance.

### Users

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/users` | List account users |
| POST | `/api/users` | Create a user |
| PATCH | `/api/users/:userId/plan` | Change a user's plan |

Example user request:

```json
{
  "externalUserId": "customer-001",
  "displayName": "Example User"
}
```

A `planId` can also be supplied when creating a user if a specific user plan is required.

### Usage Consumption

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/consume` | Evaluate and record a usage request |
| GET | `/api/usage` | View usage information |
| GET | `/api/history` | View recorded decisions |

Example consumption request:

```json
{
  "userId": "USER_UUID",
  "units": 10,
  "requestId": "request-001"
}
```

Send this JSON to `POST /api/consume` with the required API key and JSON headers.

Replace `USER_UUID` with an actual user ID returned by the API.

The response's `accepted` field indicates whether the usage request was accepted. A successful HTTP response means the decision was processed; it does not necessarily mean the usage was accepted.

Use a unique `requestId` for each distinct request. Reusing a request ID with different input can return a conflict response.

### Usage and History Filters

The usage endpoint accepts an optional month:

```text
GET /api/usage?month=2026-10
```

The history endpoint supports optional pagination and filters:

```text
GET /api/history?month=2026-10&page=1&pageSize=20
GET /api/history?userId=USER_UUID&page=1&pageSize=20
```

Use the actual user ID when filtering by user. The supported month format is `YYYY-MM`.

## Authentication

Protected API endpoints require the account API key in the `X-API-Key` header.

- Keep API keys and `.env` private.
- Do not commit credentials or secrets.
- Use `.env.example` as the environment configuration template.

## Docker

Start the services:

```bash
docker compose up --build -d
```

Check running services:

```bash
docker compose ps
```

View API logs:

```bash
docker compose logs -f api
```

Stop the services:

```bash
docker compose down
```

## Project Structure

- `src/` - Application source code.
- `db/` - Database schema and seed data.
- `scripts/` - Utility scripts.
- `public/` - Demo page assets.
- `benchmark-results/` - Benchmark output.
- `compose.yaml` - Docker Compose configuration.
- `Dockerfile` - Application container configuration.

## Performance Testing

The project includes a reproducible HTTP load test:

```bash
docker compose up --build -d
npm run benchmark
```

Run the benchmark from the project directory while the API and PostgreSQL
services are healthy and reachable at `http://127.0.0.1:8080`.

### Default workload

- Requests: 1,000
- Concurrency: 25 workers
- Units per request: 1
- Isolation: a dedicated account and user are created for each run
- Measurement: elapsed time from sending a request until its complete response
  body is received
- Data integrity: the script checks that persisted account and user usage
  matches the expected total after the workload

The script saves a JSON report in `benchmark-results/`.

### Configuration

The workload can be adjusted with environment variables:

```bash
BENCH_REQUESTS=500 BENCH_CONCURRENCY=10 BENCH_UNITS=1 npm run benchmark
```

Supported variables:

- `BASE_URL`: API base URL; defaults to `http://127.0.0.1:8080`.
- `BENCH_REQUESTS`: number of requests; defaults to `1000`.
- `BENCH_CONCURRENCY`: number of concurrent workers; defaults to `25`.
- `BENCH_UNITS`: units consumed per request; defaults to `1`.

### Recorded results

A successful run on this development environment on 2026-10-18 processed
1,000 requests with 25 workers and one unit per request:

| Metric | Result |
| --- | ---: |
| Completed requests | 1,000 |
| Accepted requests | 1,000 |
| Request errors | 0 |
| Throughput | 105.83 requests/second |
| Median latency | 222.05 ms |
| P95 latency | 327.52 ms |
| P99 latency | 511.11 ms |
| Account usage matched expected total | Yes |
| User usage matched expected total | Yes |

These figures are measurements from one local development run, not a production
capacity guarantee. Results depend on the machine, Docker configuration,
database state, and workload.

An earlier run on 2026-10-16 recorded five request errors (two HTTP 500 and
three HTTP 503). Later runs succeeded, including the integrity-checked run
above. This demonstrates why repeated runs and error counts matter; the
earlier failure should not be treated as a successful benchmark.

### What this test tells us

The benchmark exercises concurrent consumption requests that share an account
quota, then verifies persisted usage. The recorded successful run confirms
that all 1,000 requested units were reflected in both account and user usage.
It is a focused load test, not a full production stress test: it does not by
itself establish behavior under prolonged traffic, multiple machines, or
production-scale workloads.

## Continuous Integration

GitHub Actions runs type checking, linting, tests, and the production build when changes are pushed or a pull request is opened.

## License

Educational final project.
