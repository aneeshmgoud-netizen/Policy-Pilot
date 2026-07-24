# Policy Pilot

AI-assisted, human-in-the-loop access-review system, built for the *Full-Stack
AI Engineer Assignment*.

**AI-assisted development disclosure**: built with Claude Code (Anthropic) as
a pair-programming assistant throughout; all decisions and verification were
directed by the author.

## Documentation

- [`docs/architecture-blueprint.md`](docs/architecture-blueprint.md) — system architecture diagram
- [`docs/technical-implementation-brief.pdf`](docs/technical-implementation-brief.pdf) — 2-page technical brief
- [`docs/CHUNKING_STRATEGY.md`](docs/CHUNKING_STRATEGY.md) — RAG chunking rationale


## Repo layout

```
backend/    NestJS API + BullMQ worker (Prisma, RAG, agent, eval)
frontend/   React + Vite + TanStack Query dashboard
docker/     docker-compose.yml (Postgres/pgvector, Redis, api, web)
policies/   Sample policy documents ingested by the RAG pipeline
docs/       Architecture blueprint, technical brief, chunking strategy
```

## Prerequisites

- Node.js 20+, Docker Desktop
- An OpenAI API key

## Setup

1. Copy env files and generate an `INGESTION_API_KEY`; set `OPENAI_API_KEY`
   in `backend/.env` (required for RAG embeddings and the recommendation
   agent):
   ```bash
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Install dependencies (npm workspaces, from repo root):
   ```bash
   npm install
   ```
3. Start Postgres (pgvector) + Redis only:
   ```bash
   docker compose -f docker/docker-compose.yml up -d postgres redis
   ```
4. Generate the Prisma client and apply migrations:
   ```bash
   npm run prisma:generate --workspace backend
   npm run prisma:migrate --workspace backend
   ```
   > Do **not** run `prisma migrate dev` on this project — it will drop the
   > pgvector HNSW index (Prisma can't represent it, so it treats the index
   > as drift). Always use `prisma:migrate` (`migrate deploy`).
5. Seed sample entitlement data (safe to re-run):
   ```bash
   npm run db:seed
   ```
6. Ingest the sample policy documents into pgvector (safe to re-run; calls
   the OpenAI embeddings API):
   ```bash
   npm run rag:ingest --workspace backend
   ```
7. Run the backend and frontend (separate terminals):
   ```bash
   npm run dev:backend
   npm run dev:frontend
   ```
8. Open http://localhost:5173 and log in as `Alice Chen` or `Bob Nakamura`
   (mocked reviewer identities — see `frontend/src/lib/mock-users.ts`).
   Backend health check: http://localhost:3000/health

### Running the full stack in Docker instead

```bash
npm run docker:up
```
Brings up all four services (Postgres, Redis, API, web) in one shot — API on
http://localhost:3000, web UI on http://localhost:8080. No hot-reload; use
the steps above for active development.

## Demo

Submit a representative set of access requests through the real ingestion
webhook (10 requests across all 6 entitlement systems, covering every
decision path, plus one intentionally malformed request):
```bash
npm run demo:requests --workspace backend
```
Then open the dashboard and refresh the request list to watch recommendations
appear as the worker processes each one. See
[`backend/demo-requests.json`](backend/demo-requests.json) for the exact
payloads and expected outcomes.

To clear submitted requests between demo runs (keeps seeded entitlements and
the ingested policy corpus intact):
```bash
docker compose -f docker/docker-compose.yml exec postgres psql -U policy_pilot -d policy_pilot -c "TRUNCATE TABLE access_requests CASCADE;"
```

To submit a single custom request, `POST` to
`http://localhost:3000/api/v1/access-requests` with an `X-API-Key` header
matching `INGESTION_API_KEY` and a body matching
[`create-access-request.dto.ts`](backend/src/ingestion/dto/create-access-request.dto.ts).

## Evaluation and tests

```bash
npm run eval --workspace backend   # golden-dataset evaluation (spends OpenAI credit)
npm test                           # backend test suite
```
