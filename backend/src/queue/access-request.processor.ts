import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { AccessRequest, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { AgentService } from '../agent/agent.service';
import { PolicyCitation, Recommendation, RecommendationResult } from '../agent/agent.types';
import { redactPiiInText } from '../common/pii.util';
import {
  EntitlementLookupResult,
  EntitlementLookupService,
} from '../entitlements/entitlement-lookup.service';
import { PrismaService } from '../prisma/prisma.service';
import { RagService, RetrievedChunk } from '../rag/rag.service';
import { ACCESS_REQUEST_QUEUE } from './queue.constants';

export interface AccessRequestJobData {
  accessRequestId: string;
  requestId: string;
}

const ENTITLEMENT_ACTOR = 'system:entitlement-lookup';
const AGENT_ACTOR = 'system:recommendation-agent';
const WORKER_ACTOR = 'system:worker';
const RETRIEVAL_LIMIT = 8;

export interface ResolvedCitation {
  policyChunkId: string;
  documentName: string;
  section: string | null;
  excerpt: string;
}

/** First dotted section number appearing anywhere in a string ("§3.2 ..." -> "3.2"). */
function sectionNumberOf(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/\d+(?:\.\d+)*/);
  return match ? match[0] : null;
}

/**
 * Map each LLM citation back to a real retrieved chunk (by document + section
 * number, falling back to document) so we persist a FK to policy_chunks. This
 * is the grounding gate: a citation that matches no retrieved chunk is dropped
 * rather than trusted. De-duplicated by chunk id.
 */
export function resolveCitations(
  citations: PolicyCitation[],
  chunks: RetrievedChunk[],
): ResolvedCitation[] {
  const resolved: ResolvedCitation[] = [];
  const seen = new Set<string>();

  for (const citation of citations) {
    const citeNumber = sectionNumberOf(citation.section);
    const match =
      chunks.find(
        (chunk) =>
          chunk.documentName === citation.document_name &&
          sectionNumberOf(chunk.section) === citeNumber,
      ) ??
      chunks.find((chunk) => chunk.documentName === citation.document_name);

    if (!match || seen.has(match.id)) {
      continue;
    }
    seen.add(match.id);
    resolved.push({
      policyChunkId: match.id,
      documentName: match.documentName,
      section: match.section,
      excerpt: citation.excerpt,
    });
  }

  return resolved;
}

const SOD_CONFLICT_MODEL_NAME = 'system:sod-conflict-rule';

/**
 * Deterministic short-circuit for an unmitigated SoD conflict. SOD_CONFLICT_PAIRS
 * (see entitlements/sod-conflict-pairs.constant.ts) is already a hard
 * compliance rule computed authoritatively by EntitlementLookupService before
 * the agent is ever invoked — policy text is unambiguous that such a
 * conflict "must be denied immediately... under any circumstances" (see
 * POL-DATA-001 §5.1 and the analogous FIN/SEC rules). Calling the LLM to
 * re-derive a decision that's already 100% determined by upstream code adds
 * cost, latency, and a (measured) chance the model doesn't follow the rule —
 * so this bypasses RAG retrieval and the agent call entirely for this one
 * fact. Exported (rather than a private method) so the golden-dataset eval
 * harness can exercise the exact same deterministic path GD-04 is meant to
 * test, instead of re-implementing it.
 *
 * Deliberately NOT applied to `alreadyHasRequestedEntitlement`: several
 * policy sections describe time-boxed grants with a renewal/recertification
 * workflow, so "already holds this entitlement" can legitimately be a
 * renewal request rather than a redundant one — telling those apart still
 * requires retrieving and reading the policy text.
 */
export function buildSodConflictRecommendation(
  // Only sodConflicts is read, so this accepts either the full
  // EntitlementLookupResult (production) or the leaner AgentEntitlementSnapshot
  // (the golden-dataset eval harness), rather than forcing eval fixtures to
  // fabricate an unused currentActiveEntitlements[].grantedDate.
  snapshot: Pick<EntitlementLookupResult, 'sodConflicts'>,
): RecommendationResult | null {
  if (snapshot.sodConflicts.length === 0) {
    return null;
  }

  const justification =
    'Denied automatically: an active Separation-of-Duties conflict was detected ' +
    'by the entitlement registry, which this system treats as an authoritative, ' +
    'non-negotiable fact rather than a matter for policy interpretation. ' +
    snapshot.sodConflicts
      .map(
        (c) =>
          `${c.ruleId} — ${c.description} (conflicts with currently-held ${c.conflictingEntitlementKey}).`,
      )
      .join(' ');

  const recommendation: Recommendation = {
    decision: 'DENY',
    justification,
    policy_citations: [],
    confidence: 1,
  };

  return {
    recommendation,
    modelName: SOD_CONFLICT_MODEL_NAME,
    promptVersion: 'n/a',
    rawResponse: recommendation,
    attemptNumber: 1,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: 0,
    },
  };
}

// Full pipeline per job: entitlement lookup (Phase 3) -> RAG retrieval (Phase 4)
// -> recommendation agent (Phase 5). Each stage advances the request's status
// and writes an append-only audit record.
//
// Rate-limited to ~60 jobs/minute per the assignment brief's downstream-system
// constraint ("Downstream systems allow approximately 60 requests per
// minute") — this bounds the concurrent load this worker places on Postgres,
// the RAG vector search, and the OpenAI API, rather than draining the queue as
// fast as Redis and Node can dispatch jobs.
@Processor(ACCESS_REQUEST_QUEUE, { limiter: { max: 60, duration: 60_000 } })
export class AccessRequestProcessor extends WorkerHost {
  private readonly logger = new Logger(AccessRequestProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlementLookupService: EntitlementLookupService,
    private readonly ragService: RagService,
    private readonly agentService: AgentService,
  ) {
    super();
  }

  async process(job: Job<AccessRequestJobData>): Promise<void> {
    try {
      const { accessRequest, snapshot } = await this.loadEntitlements(job);
      await this.generateRecommendation(accessRequest, snapshot);
    } catch (error) {
      // Record why processing failed before re-throwing. Re-throwing keeps
      // BullMQ's retry/backoff in control; recordFailure only transitions the
      // request to FAILED once retries are exhausted, so a later successful
      // retry can still advance the request.
      await this.recordFailure(job, error);
      throw error;
    }
  }

  private async loadEntitlements(
    job: Job<AccessRequestJobData>,
  ): Promise<{ accessRequest: AccessRequest; snapshot: EntitlementLookupResult }> {
    const { accessRequestId, requestId } = job.data;

    const accessRequest = await this.prisma.accessRequest.findUniqueOrThrow({
      where: { id: accessRequestId },
    });

    const snapshot = await this.entitlementLookupService.lookup(
      accessRequest.employeeId,
      accessRequest.targetSystem,
      accessRequest.entitlementKey,
    );

    // Dates aren't valid Prisma Json input on their own — serialize to ISO
    // strings before freezing the snapshot onto the request row.
    const snapshotForStorage = {
      currentActiveEntitlements: snapshot.currentActiveEntitlements.map(
        (entitlement) => ({
          ...entitlement,
          grantedDate: entitlement.grantedDate.toISOString(),
        }),
      ),
      alreadyHasRequestedEntitlement: snapshot.alreadyHasRequestedEntitlement,
      sodConflicts: snapshot.sodConflicts,
    } as unknown as Prisma.InputJsonValue;

    await this.prisma.$transaction([
      this.prisma.accessRequest.update({
        where: { id: accessRequestId },
        data: {
          entitlementSnapshot: snapshotForStorage,
          status: 'ENTITLEMENTS_LOADED',
        },
      }),
      this.prisma.auditLog.create({
        data: {
          accessRequestId,
          eventType: 'ENTITLEMENTS_LOADED',
          actor: ENTITLEMENT_ACTOR,
          payload: {
            activeEntitlementCount: snapshot.currentActiveEntitlements.length,
            alreadyHasRequestedEntitlement:
              snapshot.alreadyHasRequestedEntitlement,
            sodConflictRuleIds: snapshot.sodConflicts.map((c) => c.ruleId),
          },
        },
      }),
    ]);

    this.logger.log(
      `Loaded entitlements for access request ${requestId} (accessRequestId=${accessRequestId}): ` +
        `${snapshot.currentActiveEntitlements.length} active, ${snapshot.sodConflicts.length} SoD conflict(s) detected`,
    );

    return { accessRequest, snapshot };
  }

  private buildRetrievalQuery(accessRequest: AccessRequest): string {
    // Untrusted justification is safe to use as a *search* query (it only
    // influences which policy is retrieved, never the decision rules).
    return (
      `${accessRequest.requestType} ${accessRequest.entitlementKey} on ` +
      `${accessRequest.targetSystem} for ${accessRequest.requesterDepartment} ` +
      `(${accessRequest.requesterCostCenter}). ${accessRequest.justification}`
    );
  }

  private async generateRecommendation(
    accessRequest: AccessRequest,
    snapshot: EntitlementLookupResult,
  ): Promise<void> {
    const shortCircuited = buildSodConflictRecommendation(snapshot);

    let chunks: RetrievedChunk[] = [];
    let result: RecommendationResult;

    if (shortCircuited) {
      result = shortCircuited;
    } else {
      chunks = await this.ragService.retrieveRelevantChunks(
        this.buildRetrievalQuery(accessRequest),
        { limit: RETRIEVAL_LIMIT },
      );

      result = await this.agentService.recommend({
        accessRequest: {
          requestId: accessRequest.requestId,
          employeeId: accessRequest.employeeId,
          requestType: accessRequest.requestType,
          targetSystem: accessRequest.targetSystem,
          entitlementKey: accessRequest.entitlementKey,
          justification: accessRequest.justification,
          requesterDepartment: accessRequest.requesterDepartment,
          requesterCostCenter: accessRequest.requesterCostCenter,
        },
        entitlementSnapshot: {
          currentActiveEntitlements: snapshot.currentActiveEntitlements.map(
            (e) => ({ systemName: e.systemName, entitlementKey: e.entitlementKey }),
          ),
          alreadyHasRequestedEntitlement: snapshot.alreadyHasRequestedEntitlement,
          sodConflicts: snapshot.sodConflicts,
        },
        retrievedChunks: chunks,
      });
    }

    const recommendation = result.recommendation;
    const citations = resolveCitations(recommendation.policy_citations, chunks);
    const accessRequestId = accessRequest.id;

    await this.prisma.$transaction(async (tx) => {
      const created = await tx.aiRecommendation.create({
        data: {
          accessRequestId,
          decision: recommendation.decision,
          justification: recommendation.justification,
          confidence: recommendation.confidence,
          modelName: result.modelName,
          promptVersion: result.promptVersion,
          rawResponse: result.rawResponse as Prisma.InputJsonValue,
          attemptNumber: result.attemptNumber,
        },
      });

      if (citations.length > 0) {
        await tx.aiRecommendationCitation.createMany({
          data: citations.map((c) => ({
            aiRecommendationId: created.id,
            policyChunkId: c.policyChunkId,
            documentName: c.documentName,
            section: c.section,
            excerpt: c.excerpt,
          })),
        });
      }

      await tx.accessRequest.update({
        where: { id: accessRequestId },
        data: { status: 'RECOMMENDED' },
      });

      await tx.auditLog.create({
        data: {
          accessRequestId,
          eventType: 'AI_RECOMMENDED',
          actor: AGENT_ACTOR,
          payload: {
            decision: recommendation.decision,
            confidence: recommendation.confidence,
            model: result.modelName,
            promptVersion: result.promptVersion,
            attemptNumber: result.attemptNumber,
            citationCount: citations.length,
            tokenUsage: {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              totalTokens: result.usage.totalTokens,
            },
            estimatedCostUsd: result.usage.estimatedCostUsd,
            latencyMs: result.usage.latencyMs,
          },
        },
      });
    });

    this.logger.log(
      `Recommendation for ${accessRequest.requestId}: ${recommendation.decision} ` +
        `(confidence ${recommendation.confidence}, ${citations.length} citation(s), ` +
        `attempt ${result.attemptNumber}, $${result.usage.estimatedCostUsd.toFixed(6)})`,
    );
  }

  private async recordFailure(
    job: Job<AccessRequestJobData>,
    error: unknown,
  ): Promise<void> {
    const { accessRequestId, requestId } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    const isFinalAttempt = attempt >= maxAttempts;
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Masked before reaching either the log line or the audit payload below:
    // an error thrown from deeper in the stack (Prisma, upstream API, etc.)
    // is not guaranteed to be free of EMP-/CC- values. redactPiiInText only
    // replaces substrings that match those id patterns — it does not touch
    // surrounding text, so this is safe to apply to a full stack trace
    // without destroying its file paths/line numbers/structure.
    const message = redactPiiInText(rawMessage);
    // Captured in addition to the message (previously stack traces weren't
    // recorded anywhere for this failure path) so engineers retain real
    // debugging context — which file/line/call chain failed — for
    // production timeouts or downstream errors, not just a one-line summary.
    const stack =
      error instanceof Error && error.stack ? redactPiiInText(error.stack) : null;

    this.logger.error(
      `Processing failed for access request ${requestId} ` +
        `(accessRequestId=${accessRequestId}), attempt ${attempt}/${maxAttempts}: ${message}`,
      stack ?? undefined,
    );

    try {
      const auditOp = this.prisma.auditLog.create({
        data: {
          accessRequestId,
          eventType: 'PROCESSING_FAILED',
          actor: WORKER_ACTOR,
          payload: {
            attempt,
            maxAttempts,
            finalAttempt: isFinalAttempt,
            error: message,
            errorStack: stack,
          },
        },
      });

      if (isFinalAttempt) {
        // Retries exhausted: transition to the terminal FAILED state and log
        // the failure in one transaction so the state change and its
        // explanation commit together (or not at all).
        await this.prisma.$transaction([
          this.prisma.accessRequest.update({
            where: { id: accessRequestId },
            data: { status: 'FAILED' },
          }),
          auditOp,
        ]);
      } else {
        // Retries remain: record the attempt but leave the request as-is.
        await auditOp;
      }
    } catch (recordError) {
      // Never let failure bookkeeping mask the original error or crash the
      // worker — the original error is still thrown by the caller and drives
      // BullMQ's retry/backoff.
      this.logger.error(
        `Failed to record processing failure for accessRequestId=${accessRequestId}: ` +
          (recordError instanceof Error
            ? recordError.message
            : String(recordError)),
      );
    }
  }
}
