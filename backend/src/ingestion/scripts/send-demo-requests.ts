// CLI: demo/showcase tool. Submits a fixed set of representative access
// requests (see ../../../demo-requests.json) through the real ingestion
// webhook, one every ~1.5s, so a live demo — or a reviewer cloning the repo —
// can watch requests move through validation -> idempotency check -> BullMQ
// enqueue -> worker -> RAG retrieval -> LLM recommendation without having to
// hand-craft curl payloads.
//
// This is deliberately distinct from golden-dataset.json: that dataset
// drives the automated eval (calls RagService/AgentService directly, no
// HTTP, no queue). This one exercises the actual webhook + queue path
// end-to-end, against whatever the seeded entitlement_registry and ingested
// policy corpus currently contain.
//
// Requires the backend already running (npm run dev:backend, or the Docker
// stack) and INGESTION_API_KEY set in backend/.env to the same value the
// running server uses.
//
// Run with: npm run demo:requests --workspace backend
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATASET_PATH = resolve(__dirname, '../../../demo-requests.json');
const DELAY_MS = 1500;

interface DemoRequest {
  id: string;
  note: string;
  payload: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const apiKey = process.env.INGESTION_API_KEY;
  if (!apiKey) {
    throw new Error(
      'INGESTION_API_KEY is not set. Copy backend/.env.example to backend/.env ' +
        'and set it to the same value the running server uses.',
    );
  }

  const baseUrl =
    process.env.DEMO_API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}/api/v1`;
  const requests: DemoRequest[] = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'));

  console.log(`Submitting ${requests.length} demo access requests to ${baseUrl}/access-requests\n`);

  for (const { id, note, payload } of requests) {
    try {
      const res = await fetch(`${baseUrl}/access-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => undefined);
      console.log(`[${id}] HTTP ${res.status} — ${note}`);
      if (body) console.log(`  -> ${JSON.stringify(body)}`);
    } catch (err) {
      console.error(`[${id}] request failed:`, err instanceof Error ? err.message : err);
    }
    await sleep(DELAY_MS);
  }

  console.log(
    '\nDone. Open the dashboard (npm run dev:frontend) and refresh the request list ' +
      'to watch recommendations appear as the worker finishes each one.',
  );
}

main().catch((err) => {
  console.error('Demo request run failed:', err);
  process.exitCode = 1;
});
