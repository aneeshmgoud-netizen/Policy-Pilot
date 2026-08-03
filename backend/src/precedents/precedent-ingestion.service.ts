import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import { toVectorLiteral } from '../rag/rag.service';
import { buildPrecedentCaseFactsText } from './precedent-case-facts';
import { CURRENT_PRECEDENT_EMBEDDING_VERSION } from './precedent-embedding-version';
import { buildPrecedentSummary } from './precedent-summary';

@Injectable()
export class PrecedentIngestionService {
  private readonly logger = new Logger(PrecedentIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  /**
   * Materialize one nominated decision as a PROPOSED precedent. The detailed
   * summary remains reviewer/model context; similarity uses only canonical
   * request facts, built by the same function used for a future request.
   */
  async ingest(decisionFeedbackId: string): Promise<void> {
    const feedback = await this.prisma.decisionFeedback.findUnique({
      where: { id: decisionFeedbackId },
      include: {
        humanDecision: {
          include: {
            accessRequest: true,
            aiRecommendation: true,
          },
        },
      },
    });

    if (!feedback) {
      this.logger.log(
        `Skipping precedent ingestion: decisionFeedbackId=${decisionFeedbackId} was not found.`,
      );
      return;
    }
    if (!feedback.precedentEligible) {
      this.logger.log(
        `Skipping precedent ingestion: decisionFeedbackId=${decisionFeedbackId} is not precedent-eligible.`,
      );
      return;
    }

    const { humanDecision } = feedback;
    const { accessRequest, aiRecommendation } = humanDecision;
    const summary = buildPrecedentSummary({
      targetSystem: accessRequest.targetSystem,
      entitlementKey: accessRequest.entitlementKey,
      requesterDepartment: accessRequest.requesterDepartment,
      requesterCostCenter: accessRequest.requesterCostCenter,
      // Modern rows use null model fields when no LLM was invoked (notably the
      // deterministic SoD path). Fall back to the effective recommendation
      // only for legacy rows that predate decisionSource provenance entirely.
      aiDecision: aiRecommendation
        ? (aiRecommendation.modelDecision ??
          (aiRecommendation.decisionSource === null
            ? aiRecommendation.decision
            : null))
        : null,
      aiConfidence: aiRecommendation
        ? (aiRecommendation.modelConfidence ??
          (aiRecommendation.decisionSource === null
            ? aiRecommendation.confidence
            : null))
        : null,
      aiJustification: aiRecommendation?.justification ?? null,
      humanOutcome: humanDecision.outcome,
      agreedWithAi: humanDecision.agreedWithAi,
      systemDecision:
        aiRecommendation?.decisionSource === 'GROUNDING_GATE' &&
        aiRecommendation.modelDecision !== null &&
        aiRecommendation.modelDecision !== aiRecommendation.decision
          ? aiRecommendation.decision
          : null,
      rationale: humanDecision.rationale,
      reasonCode: feedback.reasonCode,
      missingContext: feedback.missingContext,
    });

    const policyVersionSnapshot = await this.prisma.policyDocument.findMany({
      select: { documentName: true, version: true },
      orderBy: { documentName: 'asc' },
    });
    const retrievalText = buildPrecedentCaseFactsText({
      requestType: accessRequest.requestType,
      targetSystem: accessRequest.targetSystem,
      entitlementKey: accessRequest.entitlementKey,
      requesterTitle: accessRequest.requesterTitle,
      requesterDepartment: accessRequest.requesterDepartment,
      requesterCostCenter: accessRequest.requesterCostCenter,
      justification: accessRequest.justification,
    });
    const vector = toVectorLiteral(
      await this.embeddings.embed(retrievalText),
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        const record = await tx.precedentRecord.create({
          data: {
            decisionFeedbackId,
            accessRequestId: accessRequest.id,
            targetSystem: accessRequest.targetSystem,
            entitlementKey: accessRequest.entitlementKey,
            department: accessRequest.requesterDepartment,
            costCenter: accessRequest.requesterCostCenter,
            summary,
            embeddingVersion: CURRENT_PRECEDENT_EMBEDDING_VERSION,
            policyVersionSnapshot,
          },
        });

        await tx.$executeRaw`
          UPDATE precedent_records
          SET embedding = ${vector}::vector
          WHERE id = ${record.id}::uuid
        `;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `Precedent ingestion already completed for decisionFeedbackId=${decisionFeedbackId}; skipping duplicate.`,
        );
        return;
      }
      throw err;
    }
  }
}
