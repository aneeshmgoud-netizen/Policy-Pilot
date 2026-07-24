# System Architecture Blueprint

Component boundaries for Policy Pilot, numbered in the order a request actually
moves through them. A rendered version is also committed as
[`architecture-blueprint.svg`](architecture-blueprint.svg); this Mermaid source
renders natively on GitHub.

- **① Synchronous** — the webhook call and its `202 Accepted` response happen
  before any AI work starts.
- **② Asynchronous** — the queue and worker process the request in the
  background, on their own schedule, rate-limited independently of how fast
  requests arrive.
- **③ Human-approval boundary** — the mock execution adapter is reachable
  *only* from a recorded human decision (`Decisions controller`). The AI
  recommendation path (worker → LLM → persisted recommendation) has no route
  to it at all — that's enforced by the code having no such call, not by a
  runtime check.

```mermaid
flowchart TB
    Upstream(["Upstream HR / ITSM<br/>(webhook caller)"])

    subgraph SYNC["① SYNCHRONOUS &nbsp;&middot;&nbsp; request / response"]
        Ingestion["NestJS API<br/>Webhook ingestion layer<br/><span style='font-size:11px'>validate &middot; API-key &middot; idempotency</span>"]
    end

    subgraph ASYNC["② ASYNCHRONOUS &nbsp;&middot;&nbsp; queue-backed processing"]
        Queue[["Asynchronous queue<br/>Redis + BullMQ<br/><span style='font-size:11px'>60/min limiter &middot; backoff + jitter</span>"]]
        Worker["Processing worker<br/><span style='font-size:11px'>entitlement lookup &rarr; RAG &rarr; LLM</span>"]
    end

    subgraph DATA["DATA & AI SERVICES"]
        direction LR
        PG[("PostgreSQL<br/><span style='font-size:11px'>entitlements &middot; requests &middot;<br/>recommendations &middot; audit log</span>")]
        VEC[("Vector store<br/>pgvector / HNSW")]
        EMB["Embedding endpoint<br/><span style='font-size:11px'>OpenAI<br/>text-embedding-3-small</span>"]
        LLM["LLM endpoint<br/><span style='font-size:11px'>OpenAI gpt-4o-mini</span>"]
    end

    Dashboard["React dashboard<br/><span style='font-size:11px'>TanStack Query</span>"]

    subgraph BOUNDARY["③ HUMAN-APPROVAL BOUNDARY"]
        Decisions["NestJS API<br/>Decisions controller"]
        Note["ONLY a recorded HUMAN decision<br/>reaches the execution adapter.<br/>The AI recommendation path never can."]
        Adapter["Mock downstream<br/>execution adapter"]
    end

    OBS["Logging / metrics / tracing<br/><span style='font-size:11px'>NestJS Logger, PII-masked, +<br/>/health &amp; /health/ready<br/>(no tracing/metrics exporter yet)</span>"]

    Upstream == "POST /access-requests" ==> Ingestion
    Ingestion == "202 Accepted<br/>(returned immediately)" ==> Upstream
    Ingestion -. "enqueue" .-> Queue
    Queue -. "consume" .-> Worker

    Worker --> PG
    Worker --> VEC
    Worker --> EMB
    Worker --> LLM
    Worker -- "persist AI recommendation" --> PG

    PG -- "pending requests +<br/>recommendations" --> Dashboard
    Dashboard == "Approve / Deny / Override<br/>(rationale required for override)" ==> Decisions
    Decisions == "human decision only" ==> Adapter
    Decisions -- "persist human decision" --> PG
    Note -.- Adapter

    Ingestion -.- OBS
    Worker -.- OBS
    Decisions -.- OBS

    classDef sync fill:#e3f2fd,stroke:#1565c0,stroke-width:1.5px
    classDef asyncc fill:#ede7f6,stroke:#5e35b1,stroke-width:1.5px
    classDef data fill:#e8f5e9,stroke:#2e7d32,stroke-width:1.5px
    classDef ai fill:#fff3e0,stroke:#ef6c00,stroke-width:1.5px
    classDef dash fill:#e1f5fe,stroke:#0277bd,stroke-width:1.5px
    classDef human fill:#ffebee,stroke:#c62828,stroke-width:3px,color:#b71c1c
    classDef obs fill:#f5f5f5,stroke:#616161,stroke-width:1px,stroke-dasharray: 3 3
    classDef note fill:#fff,stroke:#c62828,stroke-width:1px,color:#c62828,stroke-dasharray: 2 2
    classDef upstream fill:#eceff1,stroke:#455a64,stroke-width:1.5px

    class Upstream upstream
    class Ingestion,Decisions sync
    class Queue,Worker asyncc
    class PG,VEC data
    class EMB,LLM ai
    class Dashboard dash
    class Adapter human
    class OBS obs
    class Note note

    style SYNC fill:#f8fbff,stroke:#1565c0,stroke-width:1px
    style ASYNC fill:#faf8ff,stroke:#5e35b1,stroke-width:1px
    style BOUNDARY fill:#fff8f8,stroke:#c62828,stroke-width:2px
```

Note: `Ingestion` and `Decisions` are drawn as two nodes because they are two
distinct NestJS controllers in the same running API process
(`backend/src/ingestion/ingestion.controller.ts` and
`backend/src/decisions/decisions.controller.ts`) — not two separate deployed
services.
