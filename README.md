# Policy Pilot

Policy Pilot is an AI-assisted, human-in-the-loop access-review system built for the Full-Stack AI Engineer Assignment.

It combines policy retrieval, historical precedent, deterministic safety checks, and human governance. The AI recommends `APPROVE`, `DENY`, or `ESCALATE`; an authorized reviewer always makes the final `GRANT` or `DENY` decision. Reviewed cases can become governed precedent, and approved operating rules can influence future recommendations without a model retrain or application deployment.

## Repository layout

```text
backend/    NestJS API, BullMQ worker, Prisma, RAG, governance, and evaluation
frontend/   React, Vite, and TanStack Query review dashboard
docker/     PostgreSQL/pgvector, Redis, API, and web containers
policies/   Sample enterprise policy documents
docs/       Architecture, V2 technical summary, and evaluation notes
```

## Documentation

- [Architecture blueprint](docs/architecture-blueprint.md)
- [V2 technical design summary](docs/Technical%20Summary%20-%20V2%20Implementation%20.pdf)
- [Evaluation report](docs/evaluation-report.md)
- [RAG chunking strategy](docs/CHUNKING_STRATEGY.md)

## Prerequisites

- Node.js 24
- Docker Desktop
- An OpenAI API key

## Local setup

Run all commands from the repository root.

1. Create the local environment files:

   ```powershell
   Copy-Item backend/.env.example backend/.env
   Copy-Item frontend/.env.example frontend/.env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Add the generated value as `INGESTION_API_KEY` in `backend/.env`, then add your `OPENAI_API_KEY`.

2. Install dependencies:

   ```powershell
   npm install
   ```

3. Start PostgreSQL and Redis:

   ```powershell
   docker compose -f docker/docker-compose.yml up -d postgres redis
   ```

4. Prepare the database and policy corpus:

   ```powershell
   npm run prisma:generate --workspace backend
   npm run prisma:migrate --workspace backend
   npm run db:seed
   npm run rag:ingest --workspace backend
   ```

   Use `prisma:migrate`, not `prisma migrate dev`; Prisma cannot represent the pgvector HNSW index and may treat it as schema drift.

5. Start the application in two terminals:

   ```powershell
   npm run dev:backend
   ```

   ```powershell
   npm run dev:frontend
   ```

6. Open [http://localhost:5173](http://localhost:5173). The development identity switcher provides:

   - Alice Chen or Bob Nakamura for request review
   - Priya Anand for precedent and operating-rule governance
   - Dana Ortiz for view-only access

   Backend health check: [http://localhost:3000/health](http://localhost:3000/health)

## Docker setup

To run the full stack without hot reload:

```powershell
npm run docker:up
```

Open the web UI at [http://localhost:8080](http://localhost:8080). The API is available at [http://localhost:3000](http://localhost:3000).

Stop the stack with:

```powershell
npm run docker:down
```

## Demo

After seeding the database and ingesting the policies, submit the 28 sample access requests through the real ingestion endpoint:

```powershell
npm run demo:requests --workspace backend
```

Open the dashboard and refresh the request list while the worker generates recommendations. The payloads and expected outcomes are defined in [backend/demo-requests.json](backend/demo-requests.json).

To submit a custom request, send a `POST` request to `http://localhost:3000/api/v1/access-requests` with an `X-API-Key` matching `INGESTION_API_KEY`. The request body is defined by [create-access-request.dto.ts](backend/src/ingestion/dto/create-access-request.dto.ts).

## Quality checks

```powershell
npm test
npm run type-check
npm run lint
npm run build
```

Run the live golden-dataset evaluation separately because it calls the OpenAI API and uses API credit:

```powershell
npm run eval --workspace backend
```
