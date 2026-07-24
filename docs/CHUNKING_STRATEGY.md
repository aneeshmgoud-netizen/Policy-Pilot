# Policy Chunking Strategy

This document defends the chunking approach used by the Policy RAG pipeline
([`backend/src/rag/chunking.ts`](../backend/src/rag/chunking.ts)). The pipeline
turns long, unstructured governance policies into retrievable units for
similarity search, so the chunk boundaries directly determine whether a
retrieved passage is a self-contained, citable rule or a mangled fragment.

## The strategy

**Split on `##`/`###` headings first, then window only what overflows.** We
parse each document into sections keyed by their markdown headings (the H1 title
plus its metadata block becomes a single "Document Header" section). Each section
becomes one chunk if it fits within a **500-token** budget; only a section that
exceeds that budget is subdivided into **500-token windows with 50 tokens of
overlap**. Every chunk is prefixed with its section heading so the heading
travels into both the embedding and the stored citation excerpt. PDFs, whose
extracted text carries plain numbered headings rather than markdown, are first
normalized so their `2.1 …`-style headings become `##`/`###`
([`pdf.ts`](../backend/src/rag/pdf.ts)) — this lets them flow through the *same*
heading-first chunker rather than a separate code path.

## Why this is the right strategy for policy documents

**Headings are the real semantic boundaries in a policy, so splitting on them
preserves meaning and prevents orphaned clauses.** These documents are written as
discrete, self-contained rules — "§3.2 Elevated Write Protocol requires secondary
`CC-GOV-01` approval and a 90-day time-box," "§5.1 SoD-DATA-01 forbids holding
`FIN_DATASET_EDIT` and `BILLING_EXPORT` together." A naive fixed-size window that
ignores structure would routinely cut across these boundaries, stranding the
*condition* of a rule in one chunk and its *consequence* in another; a retrieval
for "can I get dataset edit access?" might then surface the approval requirement
without the time-box, or a conflict's first entitlement without its second. By
cutting on headings first, each rule stays intact inside a single chunk, and each
chunk carries its section label so the LLM (and a human auditor reading a
citation) knows exactly which clause it is looking at. Because most policy
sections are short, the overwhelming majority of chunks are exactly one
semantically-complete section — the dry-run over the real corpus shows a maximum
of ~340 tokens per chunk, comfortably inside the budget.

**The 500-token / 50-token-overlap window is the safety net for the rare
oversized section, tuned to stay well within embedding and prompt-context
limits.** 500 tokens is small enough that several retrieved chunks fit together
inside the recommendation model's context window alongside the request, the
entitlement snapshot, and the system instructions — leaving ample room for the
generated rationale — yet large enough to hold a complete multi-sentence clause
without fragmenting it. When a section does exceed the budget, the 50-token
(~10%) overlap guarantees that a rule straddling a window boundary is reproduced
in full in at least one chunk, so no clause is orphaned by the split itself; the
overlap is deliberately small to avoid bloating the index with redundant tokens
or letting duplicated passages crowd out distinct results at retrieval time.
Together, heading-first splitting plus bounded overlapping windows give chunks
that are semantically whole, individually citable, and uniformly sized for
embedding and retrieval.
