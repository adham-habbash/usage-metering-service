# Usage Metering Service

A TypeScript backend service for tracking usage, enforcing account and
user limits, and recording usage decisions in PostgreSQL.

## Features

- REST API built with TypeScript and Express.
- PostgreSQL database for persistent storage.
- Configurable plans and usage limits.
- Account-level and user-level usage enforcement.
- Request history for tracking usage decisions.
- Input validation and centralized error handling.
- Docker Compose support for local development.
- Automated tests and code-quality checks.

## Technology Stack

- Node.js
- TypeScript
- Express
- PostgreSQL
- Docker and Docker Compose
- Vitest

## Prerequisites

- Node.js
- npm
- Docker Desktop or Docker Engine with Docker Compose

## Setup

1. Clone the repository.
2. Install dependencies:

   ```bash
   npm ci
   ```

3. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

4. Review `.env` and configure the database connection if necessary.
5. Start the services:

   ```bash
   docker compose up --build -d
   ```

## Development Commands

Run the available project checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Docker

Start the application and database:

```bash
docker compose up --build -d
```

Check service status:

```bash
docker compose ps
```

View application logs:

```bash
docker compose logs -f api
```

Stop the services:

```bash
docker compose down
```

## Configuration and Security

- Keep `.env` local and never commit secrets.
- Use `.env.example` as the configuration template.
- Do not store passwords, tokens, or production credentials in Git.

## Project Structure

- `src/` - Application source code.
- `db/` - Database schema and seed data.
- `scripts/` - Project utility scripts.
- `benchmark-results/` - Benchmark output.
- `compose.yaml` - Docker Compose configuration.
- `Dockerfile` - Application container configuration.

## Continuous Integration

GitHub Actions runs the project's type checks, linting, tests, and build
when changes are pushed or a pull request is opened.

## License

Educational final project.
