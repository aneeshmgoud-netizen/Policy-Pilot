import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { AccessRequest, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { AgentService } from '../agent/agent.service';
import {
  AgentOperatingRule,
  Recommendation,
  RecommendationResult,
} from '../agent/agent.types';
import {
  EntitlementLookupResult,
  EntitlementLookupService,
} from '../entitlements/entitlement-lookup.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  OperatingRuleRetrievalService,
  toAgentOperatingRule,
} from '../precedents/operating-rule-retrieval.service';
import {
  PrecedentRetrievalService,
  toAgentPrecedent,
} from '../precedents/precedent-retrieval.service';
import { RagService } from '../rag/rag.service';
import {
  codeForStage,
  PROCESSING_ERROR_CODES,
  PROCESSING_STAGES,
  ProcessingErrorCode,
  processingErrorMessage,
  ProcessingStage,
  SanitizedProcessingError,
} from './processing-error.util';
import { ACCESS_REQUEST_QUEUE } from './queue.constants';
import { RecommendationGroundingService } from './recommendation-grounding.service';

export interface AccessRequestJobData {
  accessRequestId: string;
  requestId: string;
}

const ENTITLEMENT_ACTOR = 'system:entitlement-lookup';
const AGENT_ACTOR = 'system:recommendation-agent';
const WORKER_ACTOR = 'system:worker';
const RETRIEVAL_LIMIT = 8;
const PRECEDENT_RETRIEVAL_LIMIT = 3;

// Thrown internally when a status-CAS discovers the request became DECIDED
// out from under an in-flight job (a duplicate/redelivered job racing a
// human decision). Caught in process() and treated as a safe no-op — never
// as a processing failure to retry or record.
class TerminalRequestError extends Error {}

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
    policy_citation_refs: [],
    precedent_citations: [],
    precedent_review: [],
    operating_rule_review: [],
    confidence: 1,
    conflict_detected: false,
    conflict_explanation: '',
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
    private readonly precedentRetrievalService: PrecedentRetrievalService,
    private readonly operatingRuleRetrievalService: OperatingRuleRetrievalService,
    private readonly agentService: AgentService,
    private readonly recommendationGrounding: RecommendationGroundingService,
  ) {
    super();
  }

  async process(job: Job<AccessRequestJobData>): Promise<void> {
    // Tracked so a failure can be attributed to a stage from a fixed set —
    // safe structured context, unlike anything read off the exception.
    let stage: ProcessingStage = PROCESSING_STAGES.LOAD_ENTITLEMENTS;
    try {
      const loaded = await this.loadEntitlements(job);
      if (loaded === null) {
        return;
      }
      stage = PROCESSING_STAGES.GENERATE_RECOMMENDATION;
      await this.generateRecommendation(loaded.accessRequest, loaded.snapshot);
    } catch (error) {
      if (error instanceof TerminalRequestError) {
        // A human decision won the race after this job had already started.
        // Not a failure: nothing about this job's work should be recorded,
        // retried, or allowed to move the request off DECIDED. This message is
        // ours, built from ids — not exception-derived text.
        this.logger.log(error.message);
        return;
      }
      // Record why processing failed before re-throwing. Re-throwing keeps
      // BullMQ's retry/backoff in control; recordFailure only transitions the
      // request to FAILED once retries are exhausted, so a later successful
      // retry can still advance the request.
      //
      // The original exception is deliberately NOT rethrown: BullMQ persists a
      // thrown error's message and stack verbatim in Redis. Only the stable
      // stage code crosses that boundary.
      const code = codeForStage(stage);
      await this.recordFailure(job, code, stage);
      throw new SanitizedProcessingError(code);
    }
  }

  private async loadEntitlements(
    job: Job<AccessRequestJobData>,
  ): Promise<{ accessRequest: AccessRequest; snapshot: EntitlementLookupResult } | null> {
    const { accessRequestId, requestId } = job.data;

    const accessRequest = await this.prisma.accessRequest.findUniqueOrThrow({
      where: { id: accessRequestId },
    });

    // DECIDED is terminal. A human can only ever decide a RECOMMENDED
    // request (see DecisionsService), so this can only be hit by a
    // duplicate/redelivered job reprocessing a request that's already been
    // through the full pipeline once — never skip the entitlement lookup or
    // touch the row for a request that's still legitimately in flight.
    if (accessRequest.status === 'DECIDED') {
      this.logger.log(
        `Skipping access request ${requestId} (accessRequestId=${accessRequestId}): ` +
          `already DECIDED by a human reviewer; a redelivered/duplicate job must not reopen it.`,
      );
      return null;
    }

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

    const advanced = await this.prisma.$transaction(async (tx) => {
      // Conditional: a human decision could have landed while the lookup
      // above was in flight. Never overwrite DECIDED, even with a snapshot.
      const transitioned = await tx.accessRequest.updateMany({
        where: { id: accessRequestId, status: { not: 'DECIDED' } },
        data: {
          entitlementSnapshot: snapshotForStorage,
          status: 'ENTITLEMENTS_LOADED',
        },
      });
      if (transitioned.count === 0) {
        return false;
      }
      await tx.auditLog.create({
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
      });
      return true;
    });

    if (!advanced) {
      this.logger.log(
        `Skipping access request ${requestId} (accessRequestId=${accessRequestId}): ` +
          `became DECIDED during entitlement lookup; discarding this snapshot.`,
      );
      return null;
    }

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

    // The rules that were IN FORCE and shown to the model for this request.
    // Named "retrieved", not "applied", on purpose: this records what the
    // model was given, which is a fact this code knows. Whether the model
    // then judged a rule applicable is its own operating_rule_review answer,
    // verified by the grounding gate. The SoD short-circuit never consults
    // rules (it never reaches the LLM), so it correctly leaves this empty.
    let retrievedOperatingRuleIds: string[] = [];
    let agentOperatingRules: AgentOperatingRule[] = [];
    let result: RecommendationResult;
    let groundingOutcome: Awaited<
      ReturnType<RecommendationGroundingService['groundSodDenial']>
    >;

    if (shortCircuited) {
      result = shortCircuited;
      // The deterministic path never asks the LLM for citations (see
      // buildSodConflictRecommendation) — it does its own targeted retrieval
      // to find the specific policy section backing the triggered rule(s)
      // before letting the DENY stand.
      groundingOutcome = await this.recommendationGrounding.groundSodDenial(
        shortCircuited,
        snapshot.sodConflicts,
      );
    } else {
      const retrievalQuery = this.buildRetrievalQuery(accessRequest);
      // Operating rules are looked up by exact scope, not by similarity, so
      // this needs no query text — see OperatingRuleRetrievalService.
      const [chunks, precedents, operatingRules] = await Promise.all([
        this.ragService.retrieveRelevantChunks(retrievalQuery, {
          limit: RETRIEVAL_LIMIT,
        }),
        this.precedentRetrievalService.retrieveRelevantPrecedents(
          {
            requestType: accessRequest.requestType,
            targetSystem: accessRequest.targetSystem,
            entitlementKey: accessRequest.entitlementKey,
            requesterTitle: accessRequest.requesterTitle,
            requesterDepartment: accessRequest.requesterDepartment,
            requesterCostCenter: accessRequest.requesterCostCenter,
            justification: accessRequest.justification,
          },
          {
            limit: PRECEDENT_RETRIEVAL_LIMIT,
          },
        ),
        this.operatingRuleRetrievalService.retrieveApplicableRules(
          accessRequest.targetSystem,
          accessRequest.entitlementKey,
        ),
      ]);
      retrievedOperatingRuleIds = operatingRules.map((rule) => rule.id);
      agentOperatingRules = operatingRules.map(toAgentOperatingRule);

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
        retrievedPrecedents: precedents.map(toAgentPrecedent),
        operatingRules: agentOperatingRules,
      });

      // Grounding gate: an APPROVE/DENY with no fully-validated source selection
      // never reaches persistence as-is — it's downgraded to ESCALATE here,
      // before the transaction even starts. See RecommendationGroundingService
      // for the fail-closed source-id policy.
      // The rules are handed to the gate as well as to the model, so an
      // ignored rule is caught deterministically rather than trusted.
      groundingOutcome = this.recommendationGrounding.groundLlmRecommendation(
        result,
        chunks,
        precedents,
        agentOperatingRules,
      );
    }

    const {
      recommendation,
      citations,
      precedentCitations,
      decisionSource,
      audit,
      rawResponse,
    } = groundingOutcome;
    const accessRequestId = accessRequest.id;
    // What the LLM proposed before grounding could rewrite it. The SoD path
    // never invokes a model, so its deterministic DENY must not be written to
    // modelDecision/modelConfidence or later counted as reviewer agreement
    // with AI.
    const proposed = result.recommendation;
    const modelWasInvoked = result.modelName !== SOD_CONFLICT_MODEL_NAME;
    const modelDecision = modelWasInvoked ? proposed.decision : null;
    const modelConfidence = modelWasInvoked ? proposed.confidence : null;

    await this.prisma.$transaction(async (tx) => {
      // Claim eligibility BEFORE persisting anything else. If a human
      // decision won the race (this request is already DECIDED), abort the
      // whole transaction here: no AiRecommendation row, no citations, no
      // AI_RECOMMENDED audit entry, no status change. Prisma rolls back
      // everything in this callback when it throws.
      const transitioned = await tx.accessRequest.updateMany({
        where: { id: accessRequestId, status: { not: 'DECIDED' } },
        data: { status: 'RECOMMENDED' },
      });
      if (transitioned.count === 0) {
        throw new TerminalRequestError(
          `Discarding recommendation for access request ${accessRequest.requestId} ` +
            `(accessRequestId=${accessRequestId}): a human decision won the race; ` +
            `the request is already DECIDED.`,
        );
      }

      const created = await tx.aiRecommendation.create({
        data: {
          accessRequestId,
          decision: recommendation.decision,
          justification: recommendation.justification,
          confidence: recommendation.confidence,
          modelName: result.modelName,
          promptVersion: result.promptVersion,
          rawResponse: rawResponse as Prisma.InputJsonValue,
          attemptNumber: result.attemptNumber,
          modelDecision,
          modelConfidence,
          decisionSource,
          retrievedOperatingRuleIds,
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

      if (precedentCitations.length > 0) {
        await tx.precedentCitation.createMany({
          data: precedentCitations.map((citation) => ({
            aiRecommendationId: created.id,
            precedentRecordId: citation.precedentRecordId,
            relevanceReason: citation.relevanceReason,
            outcomeSnapshot: citation.outcomeSnapshot,
            summarySnapshot: citation.summarySnapshot,
          })),
        });
      }

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
            decisionSource,
            modelDecision,
            retrievedOperatingRuleCount: retrievedOperatingRuleIds.length,
            tokenUsage: {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              totalTokens: result.usage.totalTokens,
            },
            estimatedCostUsd: result.usage.estimatedCostUsd,
            latencyMs: result.usage.latencyMs,
            // Auditability for the grounding gate: counts and stable reason
            // codes only — never raw excerpt/chunk text (see GroundingAudit).
            grounding: audit as unknown as Prisma.InputJsonValue,
          },
        },
      });
    });

    this.logger.log(
      `Recommendation for ${accessRequest.requestId}: ${recommendation.decision} ` +
        `(confidence ${recommendation.confidence}, ${citations.length} citation(s), ` +
        `attempt ${result.attemptNumber}, $${result.usage.estimatedCostUsd.toFixed(6)})` +
        (audit.convertedToEscalate ? ' [downgraded to ESCALATE: ungrounded evidence]' : ''),
    );
  }

  private async recordFailure(
    job: Job<AccessRequestJobData>,
    code: ProcessingErrorCode,
    stage: ProcessingStage,
  ): Promise<void> {
    const { accessRequestId, requestId } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    const isFinalAttempt = attempt >= maxAttempts;

    // Content-free: the thrown value is never passed to this method, so there
    // is nothing exception-derived in scope to log or persist. What remains is
    // the stable code, the fixed message for it, and safe structured context
    // (request id, stage, attempt counters). See processing-error.util.ts for
    // why the previous redacted message + stack capture was insufficient.
    this.logger.error(
      `Processing failed for access request ${requestId} ` +
        `(accessRequestId=${accessRequestId}), stage ${stage}, ` +
        `attempt ${attempt}/${maxAttempts}: ${code} — ` +
        `${processingErrorMessage(code)}`,
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
            stage,
            errorCode: code,
          },
        },
      });

      if (isFinalAttempt) {
        // Retries exhausted: transition to the terminal FAILED state and log
        // the failure in one transaction so the state change and its
        // explanation commit together (or not at all). Conditional so a
        // request a human already decided (DECIDED) is never overwritten —
        // this failure record still gets written either way, it just
        // doesn't affect status if that guard doesn't match.
        await this.prisma.$transaction([
          this.prisma.accessRequest.updateMany({
            where: { id: accessRequestId, status: { not: 'DECIDED' } },
            data: { status: 'FAILED' },
          }),
          auditOp,
        ]);
      } else {
        // Retries remain: record the attempt but leave the request as-is.
        await auditOp;
      }
    } catch {
      // Never let failure bookkeeping mask the original failure or crash the
      // worker — the caller still throws (a sanitized error), which drives
      // BullMQ's retry/backoff. The caught value is not inspected.
      this.logger.error(
        `Failed to record processing failure for accessRequestId=${accessRequestId}: ` +
          `${PROCESSING_ERROR_CODES.FAILURE_BOOKKEEPING_FAILED} — ` +
          `${processingErrorMessage(PROCESSING_ERROR_CODES.FAILURE_BOOKKEEPING_FAILED)}`,
      );
    }
  }
}
