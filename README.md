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

## Continuous Integration

GitHub Actions runs type checking, linting, tests, and the production build when changes are pushed or a pull request is opened.

## License

Educational final project.
