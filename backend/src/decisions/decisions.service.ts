import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  PRECEDENT_INGESTION_JOB_NAME,
  PRECEDENT_INGESTION_QUEUE,
} from '../precedents/precedent-ingestion.constants';
import { PrecedentIngestionJobData } from '../precedents/precedent-ingestion.processor';
import { PrismaService } from '../prisma/prisma.service';
import {
  DECISION_EXECUTION_JOB_NAME,
  DECISION_EXECUTION_QUEUE,
} from './decision-execution.constants';
import { DecisionExecutionJobData } from './decision-execution.processor';
import {
  OPERATIONAL_ERROR_CODES,
  runContentFree,
} from './execution-error.util';
import { CreateDecisionDto, DecisionOutcomeValue } from './dto/create-decision.dto';

// Response shapes returned to the dashboard. Deliberately a curated projection
// (not raw Prisma rows) so we don't leak internal-only fields like the LLM's
// full rawResponse — or, for execution failures, the raw exception message.
export interface CitationView {
  documentName: string;
  section: string | null;
  excerpt: string;
}

export interface PrecedentCitationView {
  precedentRecordId: string;
  relevanceReason: string;
  outcomeSnapshot: string;
  summarySnapshot: string;
}

export interface RecommendationView {
  id: string;
  // The EFFECTIVE recommendation the reviewer acts on, after grounding.
  decision: string;
  justification: string;
  confidence: number;
  modelName: string;
  promptVersion: string;
  attemptNumber: number;
  createdAt: Date;
  citations: CitationView[];
  precedentCitations: PrecedentCitationView[];
  // Provenance. When decisionSource is GROUNDING_GATE, `decision` and
  // `justification` above were authored by RecommendationGroundingService,
  // not the model — and modelDecision/modelConfidence are what the model
  // itself proposed. Those model fields are also null when no model was
  // invoked, such as a deterministic SoD short-circuit. decisionSource is
  // null only for rows written before provenance tracking existed.
  modelDecision: string | null;
  modelConfidence: number | null;
  decisionSource: string | null;
}

export interface ExecutionView {
  status: string;
  attempts: number;
  // A stable, generic code (e.g. DOWNSTREAM_EXECUTION_FAILED) — never the
  // raw sanitized message. See execution-error.util.ts and RequestDetail.tsx
  // for why: even a redacted message can still carry infrastructure detail
  // (hostnames, internal error shapes) that shouldn't reach a reviewer's
  // browser. lastError is intentionally not part of this view.
  errorCode: string | null;
}

export interface FeedbackView {
  reasonCode: string;
  missingContext: string | null;
  precedentEligible: boolean;
  precedentStatus: string | null;
  precedentApprovedAt: Date | null;
}

export interface HumanDecisionView {
  id: string;
  outcome: string;
  overridesRecommendation: boolean;
  // Null when there was no model proposal to compare against.
  agreedWithAi: boolean | null;
  rationale: string | null;
  reviewerId: string;
  createdAt: Date;
  execution: ExecutionView | null;
  feedback: FeedbackView | null;
}

export interface AccessRequestView {
  id: string;
  requestId: string;
  employeeId: string;
  requestType: string;
  targetSystem: string;
  entitlementKey: string;
  justification: string;
  requesterTitle: string;
  requesterDepartment: string;
  requesterCostCenter: string;
  status: string;
  entitlementSnapshot: unknown;
  submittedAt: Date;
  createdAt: Date;
  recommendations: RecommendationView[];
  humanDecisions: HumanDecisionView[];
}

// Maps an AI recommendation's decision onto the outcome it implies, so a
// human decision can be compared against it. ESCALATE implies no safe
// default outcome, so anything a reviewer chooses counts as a deviation.
function impliedOutcome(
  recommendationDecision: string | undefined,
): DecisionOutcomeValue | null {
  if (recommendationDecision === 'APPROVE') return 'GRANT';
  if (recommendationDecision === 'DENY') return 'DENY';
  return null;
}

@Injectable()
export class DecisionsService {
  private readonly logger = new Logger(DecisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(DECISION_EXECUTION_QUEUE)
    private readonly executionQueue: Queue<DecisionExecutionJobData>,
    @InjectQueue(PRECEDENT_INGESTION_QUEUE)
    private readonly precedentIngestionQueue: Queue<PrecedentIngestionJobData>,
  ) {}

  /** All access requests, newest first, with their AI recommendations + citations and any human decisions. */
  async listAccessRequests(): Promise<AccessRequestView[]> {
    const requests = await this.prisma.accessRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        recommendations: {
          orderBy: { createdAt: 'desc' },
          include: { citations: true, precedentCitations: true },
        },
        humanDecisions: {
          orderBy: { createdAt: 'desc' },
          include: {
            execution: true,
            feedback: { include: { precedent: true } },
          },
        },
      },
    });

    return requests.map((request) => ({
      id: request.id,
      requestId: request.requestId,
      employeeId: request.employeeId,
      requestType: request.requestType,
      targetSystem: request.targetSystem,
      entitlementKey: request.entitlementKey,
      justification: request.justification,
      requesterTitle: request.requesterTitle,
      requesterDepartment: request.requesterDepartment,
      requesterCostCenter: request.requesterCostCenter,
      status: request.status,
      entitlementSnapshot: request.entitlementSnapshot,
      submittedAt: request.submittedAt,
      createdAt: request.createdAt,
      recommendations: request.recommendations.map((rec) => ({
        id: rec.id,
        decision: rec.decision,
        justification: rec.justification,
        confidence: rec.confidence,
        modelName: rec.modelName,
        promptVersion: rec.promptVersion,
        attemptNumber: rec.attemptNumber,
        createdAt: rec.createdAt,
        modelDecision: rec.modelDecision,
        modelConfidence: rec.modelConfidence,
        decisionSource: rec.decisionSource,
        citations: rec.citations.map((c) => ({
          documentName: c.documentName,
          section: c.section,
          excerpt: c.excerpt,
        })),
        precedentCitations: rec.precedentCitations.map((citation) => ({
          precedentRecordId: citation.precedentRecordId,
          relevanceReason: citation.relevanceReason,
          outcomeSnapshot: citation.outcomeSnapshot,
          summarySnapshot: citation.summarySnapshot,
        })),
      })),
      humanDecisions: request.humanDecisions.map((d) => ({
        id: d.id,
        outcome: d.outcome,
        overridesRecommendation: d.overridesRecommendation,
        agreedWithAi: d.agreedWithAi,
        rationale: d.rationale,
        reviewerId: d.reviewerId,
        createdAt: d.createdAt,
        execution: d.execution
          ? {
              status: d.execution.status,
              attempts: d.execution.attempts,
              errorCode: d.execution.errorCode,
            }
          : null,
        feedback: d.feedback
          ? {
              reasonCode: d.feedback.reasonCode,
              missingContext: d.feedback.missingContext,
              precedentEligible: d.feedback.precedentEligible,
              precedentStatus: d.feedback.precedent?.status ?? null,
              precedentApprovedAt: d.feedback.precedent?.approvedAt ?? null,
            }
          : null,
      })),
    }));
  }

  /**
   * Record a human decision: persist it, transition the request to DECIDED,
   * create exactly one PENDING execution row, and write a HUMAN_DECIDED
   * audit entry — all atomically. Execution itself happens asynchronously,
   * outside this transaction and outside this request/response cycle; see
   * DecisionExecutionProcessor.
   *
   * Safety properties:
   * - Only a request currently in RECOMMENDED status can be decided.
   * - The RECOMMENDED -> DECIDED transition is a conditional update inside
   *   the transaction (a compare-and-swap on status), so two concurrent
   *   decision submissions can't both win: the loser's update matches zero
   *   rows and the transaction aborts with a conflict.
   * - human_decisions.access_request_id is unique at the DB level, so even a
   *   gap in that logic can't produce two decisions for the same request.
   * - Rationale is required whenever the reviewer's outcome disagrees with
   *   what the AI recommended (or there was no clear recommendation to
   *   agree with), computed server-side from the actual recommendation —
   *   not from a client-asserted "this is an override" flag.
   * - This method never calls ExecutionAdapter. It only ever creates a
   *   PENDING outbox row and enqueues a job referencing it by id — the same
   *   id becomes the downstream idempotency key (see
   *   DecisionExecutionProcessor). If the enqueue call itself fails (e.g.
   *   Redis is briefly unavailable), the row is left PENDING and
   *   DecisionExecutionSweeperService recovers it; the human decision itself
   *   is never lost or retried.
   */
  async recordDecision(
    accessRequestId: string,
    dto: CreateDecisionDto,
    reviewerId: string,
  ): Promise<{
    id: string;
    accessRequestId: string;
    outcome: DecisionOutcomeValue;
    overridesRecommendation: boolean;
    status: 'DECIDED';
    executionStatus: 'PENDING';
    feedbackCaptured: boolean;
  }> {
    const accessRequest = await this.prisma.accessRequest.findUnique({
      where: { id: accessRequestId },
      include: {
        recommendations: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!accessRequest) {
      throw new NotFoundException(
        `Access request ${accessRequestId} not found`,
      );
    }
    if (accessRequest.status !== 'RECOMMENDED') {
      throw new ConflictException(
        `Access request ${accessRequestId} is not awaiting a decision (status=${accessRequest.status})`,
      );
    }

    const rationale = dto.rationale?.trim() ? dto.rationale.trim() : null;
    const latestRecommendation = accessRequest.recommendations[0] ?? null;

    // Two different questions, deliberately answered against two different
    // decisions.
    //
    // overridesRecommendation: did the reviewer deviate from the EFFECTIVE
    // recommendation they were shown? That is the safety question, and it is
    // what makes a rationale mandatory — including on every ESCALATE, where
    // the system declined to stand behind any outcome.
    const overridesRecommendation =
      impliedOutcome(latestRecommendation?.decision) !== dto.outcome;

    // agreedWithAi: did the reviewer agree with what the MODEL proposed? A
    // deterministic SoD recommendation is not an AI proposal. Ignore a stale
    // modelDecision on SOD_RULE rows defensively; the data migration clears
    // those values, while this guard keeps semantics correct during rollout.
    const modelDecision =
      latestRecommendation?.decisionSource === 'SOD_RULE'
        ? null
        : (latestRecommendation?.modelDecision ?? null);
    const agreedWithAi =
      modelDecision === null ? null : impliedOutcome(modelDecision) === dto.outcome;

    if (overridesRecommendation && rationale === null) {
      throw new BadRequestException(
        'rationale is required when the decision overrides the AI recommendation',
      );
    }

    let created: {
      decisionId: string;
      executionId: string;
      feedbackCaptured: boolean;
      feedbackId: string;
    };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Conditional transition: only succeeds if the request is still
        // RECOMMENDED at commit time. Under READ COMMITTED, a concurrent
        // transaction attempting the same update blocks on the row lock and
        // then re-evaluates this WHERE clause against the now-committed
        // status, so at most one of two racing decisions can ever match.
        const transitioned = await tx.accessRequest.updateMany({
          where: { id: accessRequestId, status: 'RECOMMENDED' },
          data: { status: 'DECIDED' },
        });
        if (transitioned.count === 0) {
          throw new ConflictException(
            `Access request ${accessRequestId} was already decided`,
          );
        }

        const decision = await tx.humanDecision.create({
          data: {
            accessRequestId,
            aiRecommendationId: latestRecommendation?.id ?? null,
            reviewerId,
            outcome: dto.outcome,
            overridesRecommendation,
            agreedWithAi,
            rationale,
          },
        });

        // Always captured — reasonCode is required by CreateDecisionDto, so
        // every decision carries a recorded reason, whether the reviewer
        // agreed with the AI or overrode it.
        const feedback = await tx.decisionFeedback.create({
          data: {
            humanDecisionId: decision.id,
            reasonCode: dto.reasonCode,
            missingContext: dto.missingContext?.trim()
              ? dto.missingContext.trim()
              : null,
            precedentEligible: dto.precedentEligible ?? false,
          },
        });
        const feedbackId: string = feedback.id;

        const execution = await tx.decisionExecution.create({
          data: {
            humanDecisionId: decision.id,
            outcome: dto.outcome,
            status: 'PENDING',
          },
        });

        await tx.auditLog.create({
          data: {
            accessRequestId,
            eventType: 'HUMAN_DECIDED',
            actor: reviewerId,
            payload: {
              outcome: dto.outcome,
              overridesRecommendation,
              agreedWithAi,
              rationaleProvided: rationale !== null,
              feedbackProvided: true,
              reasonCode: dto.reasonCode,
              precedentEligible: dto.precedentEligible ?? false,
              aiRecommendationId: latestRecommendation?.id ?? null,
              executionId: execution.id,
            },
          },
        });

        return {
          decisionId: decision.id,
          executionId: execution.id,
          feedbackCaptured: true,
          feedbackId,
        };
      });
    } catch (err) {
      // The unique constraint on human_decisions.access_request_id is the
      // DB-level backstop for the same race the status CAS above already
      // guards against; surface both as the same 409.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `Access request ${accessRequestId} was already decided`,
        );
      }
      throw err;
    }

    // Enqueue only after the decision is durably committed. jobId is the
    // execution row's own id, so a duplicate/retried enqueue call resolves
    // to the same BullMQ job instead of creating a second one. If this call
    // itself throws (e.g. Redis briefly unreachable), the row stays PENDING
    // — the sweeper will find and re-enqueue it. Either way, the already-
    // committed human decision is never rolled back or duplicated.
    const enqueued = await runContentFree(
      OPERATIONAL_ERROR_CODES.INITIAL_EXECUTION_ENQUEUE_FAILED,
      () =>
        this.executionQueue.add(
          DECISION_EXECUTION_JOB_NAME,
          { executionId: created.executionId },
          { jobId: created.executionId },
        ),
    );
    if (!enqueued.ok) {
      // Content-free: a Redis/BullMQ exception body can carry connection
      // strings, credentials, and internal hostnames. Only the stable code
      // plus safe ids are logged — see common/operational-error.util.ts.
      this.logger.warn(
        `Failed to enqueue execution ${created.executionId} for access request ` +
          `${accessRequestId}: ${enqueued.code}. It remains PENDING and will be ` +
          `picked up by the sweeper.`,
      );
    }

    if (dto.precedentEligible) {
      const feedbackId = created.feedbackId;
      const enqueuedPrecedent = await runContentFree(
        OPERATIONAL_ERROR_CODES.INITIAL_PRECEDENT_ENQUEUE_FAILED,
        () =>
          this.precedentIngestionQueue.add(
            PRECEDENT_INGESTION_JOB_NAME,
            { decisionFeedbackId: feedbackId },
            { jobId: feedbackId },
          ),
      );
      if (!enqueuedPrecedent.ok) {
        this.logger.warn(
          `Failed to enqueue precedent ingestion for decisionFeedbackId=${feedbackId}: ` +
            `${enqueuedPrecedent.code}. The nomination is durably committed, so ` +
            `PrecedentIngestionSweeperService will re-enqueue it.`,
        );
      }
    }

    return {
      id: created.decisionId,
      accessRequestId,
      outcome: dto.outcome,
      overridesRecommendation,
      status: 'DECIDED',
      executionStatus: 'PENDING',
      feedbackCaptured: created.feedbackCaptured,
    };
  }
}
