# CLAUDE.md - Policy Pilot Project Guide

## Overview
**Policy Pilot** is an enterprise AI-assisted access-review system that automates self-service access request evaluation using Retrieval-Augmented Generation (RAG), PostgreSQL, pgvector, NestJS, and React.

> **CRITICAL RULE**: The system enforces **Strict Human-in-the-Loop (HITL)** controls. The AI recommendation engine suggests decisions (`APPROVE`, `DENY`, `ESCALATE`), but **only human reviewers can execute entitlement mutations**.

---

## Tech Stack Summary
- **Backend**: NestJS, TypeScript, Node.js, Prisma ORM
- **Frontend**: React, TanStack React Query, TypeScript, Vite
- **Data Stores**: PostgreSQL + `pgvector` (Relational data & vector embeddings), Redis (BullMQ queue & idempotency)
- **AI & RAG**: OpenAI / Gemini API, Zod schema validation, LangChain / SDK vector search
- **Infra & Tooling**: Docker Compose, GitHub Actions CI



## Architectural Principles & Strict Guidelines

1. **Human-in-the-Loop (HITL) Boundary**:
   - The AI recommendation agent output must **never** directly mutate system entitlements.
   - Human decisions (`APPROVE`, `DENY`, `OVERRIDE`) are recorded separately from AI recommendations.
   - Overrides require a non-empty rationale from the reviewer.

2. **Asynchronous Request Ingestion**:
   - Webhook endpoint (`POST /api/v1/access-requests`) returns `202 Accepted` immediately with `request_id`.
   - Webhook processing is offloaded to a BullMQ worker queue.
   - Idempotency checks must prevent duplicate processing for identical request IDs or idempotency keys.

3. **PII & Data Protection**:
   - Employee IDs (`EMP-XXXXX`) and Cost Center codes (`CC-XXXXX`) **must be masked** in all application logs and telemetry traces.
   - Untrusted request justification text must be strictly separated from system/policy instructions in LLM prompts to prevent prompt injection.

4. **Structured & Validated AI Outputs**:
   - All LLM outputs must be validated against a strict Zod / JSON schema before persistence.
   - Malformed responses must trigger automated retries (up to 3 attempts) or escalate to human review.

5. **Append-Only Audit Logging**:
   - Every request state transition and decision (ingestion, RAG retrieval, AI recommendation, human decision, execution) must produce an append-only audit record in PostgreSQL.

---

## Code Style & Conventions

- **TypeScript**: Enforce strict mode. Avoid `any`. Use explicit interfaces/DTOs for API requests & responses.
- **NestJS**: Follow modular architecture (`*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.dto.ts`). Use NestJS validation pipes & exception filters.
- **React**: Functional components with hooks. Use TanStack React Query for all server-state queries and mutations. Do **not** call `fetch`/`axios` directly inside components.
- **Error Handling**: Use standard HTTP error response structures. Never leak stack traces or secret credentials in client responses.

---
