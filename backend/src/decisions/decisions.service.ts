import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDecisionDto } from './dto/create-decision.dto';
import { ExecutionAdapter } from './execution-adapter.service';

// Response shapes returned to the dashboard. Deliberately a curated projection
// (not raw Prisma rows) so we don't leak internal-only fields like the LLM's
// full rawResponse.
export interface CitationView {
  documentName: string;
  section: string | null;
  excerpt: string;
}

export interface RecommendationView {
  id: string;
  decision: string;
  justification: string;
  confidence: number;
  modelName: string;
  promptVersion: string;
  attemptNumber: number;
  createdAt: Date;
  citations: CitationView[];
}

export interface HumanDecisionView {
  id: string;
  decision: string;
  rationale: string | null;
  reviewerId: string;
  createdAt: Date;
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

@Injectable()
export class DecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executionAdapter: ExecutionAdapter,
  ) {}

  /** All access requests, newest first, with their AI recommendations + citations and any human decisions. */
  async listAccessRequests(): Promise<AccessRequestView[]> {
    const requests = await this.prisma.accessRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        recommendations: {
          orderBy: { createdAt: 'desc' },
          include: { citations: true },
        },
        humanDecisions: { orderBy: { createdAt: 'desc' } },
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
        citations: rec.citations.map((c) => ({
          documentName: c.documentName,
          section: c.section,
          excerpt: c.excerpt,
        })),
      })),
      humanDecisions: request.humanDecisions.map((d) => ({
        id: d.id,
        decision: d.decision,
        rationale: d.rationale,
        reviewerId: d.reviewerId,
        createdAt: d.createdAt,
      })),
    }));
  }

  /**
   * Record a human decision: persist it, transition the request to DECIDED, and
   * write a HUMAN_DECIDED audit entry — all in one transaction — then hand the
   * decision to the (mocked) execution boundary.
   */
  async recordDecision(
    accessRequestId: string,
    dto: CreateDecisionDto,
    reviewerId: string,
  ): Promise<{
    id: string;
    accessRequestId: string;
    decisionType: string;
    status: 'DECIDED';
  }> {
    // Defense-in-depth: the DTO pipe and a DB CHECK also enforce this, but guard
    // here too so a direct service call can't bypass the rule.
    const rationale = dto.rationale?.trim() ? dto.rationale.trim() : null;
    if (dto.decisionType === 'OVERRIDE' && rationale === null) {
      throw new BadRequestException(
        'rationale is required when decisionType is OVERRIDE',
      );
    }

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

    const latestRecommendationId =
      accessRequest.recommendations[0]?.id ?? null;

    const humanDecision = await this.prisma.$transaction(async (tx) => {
      const decision = await tx.humanDecision.create({
        data: {
          accessRequestId,
          aiRecommendationId: latestRecommendationId,
          reviewerId,
          decision: dto.decisionType,
          rationale,
        },
      });

      await tx.accessRequest.update({
        where: { id: accessRequestId },
        data: { status: 'DECIDED' },
      });

      await tx.auditLog.create({
        data: {
          accessRequestId,
          eventType: 'HUMAN_DECIDED',
          actor: reviewerId,
          payload: {
            decisionType: dto.decisionType,
            rationaleProvided: rationale !== null,
            aiRecommendationId: latestRecommendationId,
          },
        },
      });

      return decision;
    });

    // Execute only after the decision is durably committed — never execute a
    // decision that failed to persist. This mocked adapter is the sole
    // entitlement-mutation path and is reached only from a human decision.
    this.executionAdapter.execute({
      decisionType: dto.decisionType,
      employeeId: accessRequest.employeeId,
      targetSystem: accessRequest.targetSystem,
      entitlementKey: accessRequest.entitlementKey,
    });

    return {
      id: humanDecision.id,
      accessRequestId,
      decisionType: dto.decisionType,
      status: 'DECIDED',
    };
  }
}
