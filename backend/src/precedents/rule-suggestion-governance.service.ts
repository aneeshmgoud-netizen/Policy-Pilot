import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OperatingRule, RuleSuggestion } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mayActivatePrecedents } from './pattern-detection';
import { PrecedentGovernanceService } from './precedent-governance.service';

export interface RuleSuggestionView {
  id: string;
  patternType: string;
  targetSystem: string;
  entitlementKey: string;
  description: string;
  supportingDecisionIds: string[];
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
}

export interface OperatingRuleView {
  id: string;
  ruleSuggestionId: string;
  targetSystem: string;
  entitlementKey: string;
  patternType: string;
  guidance: string;
  status: string;
  approvedBy: string;
  approvedAt: Date;
  revokedBy: string | null;
  revokedReason: string | null;
  revokedAt: Date | null;
}

function toOperatingRuleView(rule: OperatingRule): OperatingRuleView {
  return {
    id: rule.id,
    ruleSuggestionId: rule.ruleSuggestionId,
    targetSystem: rule.targetSystem,
    entitlementKey: rule.entitlementKey,
    patternType: rule.patternType,
    guidance: rule.guidance,
    status: rule.status,
    approvedBy: rule.approvedBy,
    approvedAt: rule.approvedAt,
    revokedBy: rule.revokedBy,
    revokedReason: rule.revokedReason,
    revokedAt: rule.revokedAt,
  };
}

const RULE_SUGGESTION_STATUSES = [
  'PROPOSED',
  'ACCEPTED',
  'DISMISSED',
] as const;
type RuleSuggestionStatusValue = (typeof RULE_SUGGESTION_STATUSES)[number];

function toRuleSuggestionView(
  suggestion: RuleSuggestion,
): RuleSuggestionView {
  return {
    id: suggestion.id,
    patternType: suggestion.patternType,
    targetSystem: suggestion.targetSystem,
    entitlementKey: suggestion.entitlementKey,
    description: suggestion.description,
    supportingDecisionIds: suggestion.supportingDecisionIds,
    status: suggestion.status,
    reviewedBy: suggestion.reviewedBy,
    reviewedAt: suggestion.reviewedAt,
    reviewNote: suggestion.reviewNote,
    createdAt: suggestion.createdAt,
  };
}

@Injectable()
export class RuleSuggestionGovernanceService {
  private readonly logger = new Logger(
    RuleSuggestionGovernanceService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly precedentGovernance: PrecedentGovernanceService,
  ) {}

  async list(status?: string): Promise<RuleSuggestionView[]> {
    if (
      status &&
      !RULE_SUGGESTION_STATUSES.includes(
        status as RuleSuggestionStatusValue,
      )
    ) {
      throw new BadRequestException(
        `status must be one of: ${RULE_SUGGESTION_STATUSES.join(', ')}`,
      );
    }

    const suggestions = await this.prisma.ruleSuggestion.findMany({
      where: status
        ? { status: status as RuleSuggestionStatusValue }
        : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return suggestions.map(toRuleSuggestionView);
  }

  /**
   * Accept a discovered pattern.
   *
   * When `guidance` is supplied, this writes an ACTIVE OperatingRule for the
   * suggestion's scope in the same transaction as the status change — that
   * rule is the thing future recommendations actually read, and is what makes
   * "an approved change influences a later request without a code or prompt
   * deployment" true directly rather than by proxy. Acceptance without
   * guidance is still permitted and audited, but the caller is told plainly
   * (via `operatingRuleId: null`) that nothing retrievable was created.
   */
  async accept(
    id: string,
    governanceActorId: string,
    reviewNote?: string,
    guidance?: string,
  ): Promise<
    RuleSuggestionView & {
      activatedPrecedentIds: string[];
      operatingRuleId: string | null;
    }
  > {
    const existing = await this.prisma.ruleSuggestion.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Rule suggestion ${id} not found`);
    }

    const normalizedReviewNote = reviewNote ?? null;
    const normalizedGuidance = guidance?.trim() ? guidance.trim() : null;
    let operatingRuleId: string | null = null;
    const accepted = await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.ruleSuggestion.updateMany({
        where: { id, status: 'PROPOSED' },
        data: {
          status: 'ACCEPTED',
          reviewedBy: governanceActorId,
          reviewedAt: new Date(),
          reviewNote: normalizedReviewNote,
        },
      });
      if (transitioned.count === 0) {
        throw new ConflictException(
          `Rule suggestion ${id} is not awaiting review (status=${existing.status})`,
        );
      }

      const updated = await tx.ruleSuggestion.findUniqueOrThrow({
        where: { id },
      });

      // Same transaction as the status change: an ACCEPTED suggestion whose
      // rule failed to write would claim governance had acted while nothing
      // readable existed.
      if (normalizedGuidance) {
        const rule = await tx.operatingRule.create({
          data: {
            ruleSuggestionId: updated.id,
            targetSystem: updated.targetSystem,
            entitlementKey: updated.entitlementKey,
            patternType: updated.patternType,
            guidance: normalizedGuidance,
            approvedBy: governanceActorId,
          },
        });
        operatingRuleId = rule.id;
      }

      await tx.auditLog.create({
        data: {
          eventType: 'RULE_SUGGESTION_ACCEPTED',
          actor: governanceActorId,
          payload: {
            ruleSuggestionId: updated.id,
            patternType: updated.patternType,
            targetSystem: updated.targetSystem,
            entitlementKey: updated.entitlementKey,
            supportingDecisionIds: updated.supportingDecisionIds,
            reviewNote: normalizedReviewNote,
            operatingRuleId,
            // Explicit, because "accepted" alone does not tell an auditor
            // whether anything now influences future requests.
            guidanceProvided: normalizedGuidance !== null,
          },
        },
      });
      return updated;
    });

    if (!operatingRuleId) {
      this.logger.log(
        `Rule suggestion ${accepted.id} accepted without guidance: no operating rule ` +
          `was created, so this acceptance does not by itself change any future ` +
          `recommendation.`,
      );
    }

    const activatedPrecedentIds: string[] = [];
    // Accepting a pattern that REPORTS a problem is an acknowledgement, not an
    // endorsement of the decisions behind it — see
    // PATTERN_TYPES_THAT_MAY_ACTIVATE_PRECEDENTS. Most importantly,
    // INCONSISTENT_DECISIONS carries decisions from both sides of the
    // disagreement, so promoting them would inject mutually contradictory
    // precedent into retrieval and manufacture the exact conflict the system
    // then has to escalate.
    if (!mayActivatePrecedents(accepted.patternType)) {
      this.logger.log(
        `Accepted rule suggestion ${accepted.id} (${accepted.patternType}) without ` +
          `activating any precedent: this pattern reports a problem rather than ` +
          `endorsing the decisions behind it. Promote individual precedents ` +
          `explicitly via governance if that is the intended corrective action.`,
      );
      return {
        ...toRuleSuggestionView(accepted),
        activatedPrecedentIds,
        operatingRuleId,
      };
    }

    for (const humanDecisionId of accepted.supportingDecisionIds) {
      const feedback = await this.prisma.decisionFeedback.findUnique({
        where: { humanDecisionId },
        include: { precedent: true },
      });

      // Pattern discovery surfaces evidence; it does not invent nominations.
      // Only a precedent that a reviewer already nominated and that still
      // awaits governance approval can be activated here.
      if (!feedback?.precedent || feedback.precedent.status !== 'PROPOSED') {
        continue;
      }

      try {
        await this.precedentGovernance.approve(
          feedback.precedent.id,
          governanceActorId,
        );
        activatedPrecedentIds.push(feedback.precedent.id);
      } catch {
        this.logger.warn(
          `Could not activate precedent ${feedback.precedent.id} while accepting ` +
            `rule suggestion ${accepted.id}; continuing with remaining evidence.`,
        );
      }
    }

    return {
      ...toRuleSuggestionView(accepted),
      activatedPrecedentIds,
      operatingRuleId,
    };
  }

  async listOperatingRules(): Promise<OperatingRuleView[]> {
    const rules = await this.prisma.operatingRule.findMany({
      orderBy: { approvedAt: 'desc' },
    });
    return rules.map(toOperatingRuleView);
  }

  /**
   * Rollback for the learning loop. Only ACTIVE rules are retrieved, so this
   * takes effect on the very next request with no deployment — the mirror of
   * PrecedentGovernanceService.revoke. The row is retained rather than
   * deleted: recommendations that were generated under this rule recorded its
   * id, and that history must stay resolvable.
   */
  async revokeOperatingRule(
    id: string,
    governanceActorId: string,
    revokedReason: string,
  ): Promise<OperatingRuleView> {
    const existing = await this.prisma.operatingRule.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Operating rule ${id} not found`);
    }

    const record = await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.operatingRule.updateMany({
        where: { id, status: 'ACTIVE' },
        data: {
          status: 'REVOKED',
          revokedBy: governanceActorId,
          revokedReason,
          revokedAt: new Date(),
        },
      });
      if (transitioned.count === 0) {
        throw new ConflictException(
          `Operating rule ${id} cannot be revoked (status=${existing.status})`,
        );
      }

      const updated = await tx.operatingRule.findUniqueOrThrow({ where: { id } });
      await tx.auditLog.create({
        data: {
          eventType: 'OPERATING_RULE_REVOKED',
          actor: governanceActorId,
          payload: {
            operatingRuleId: updated.id,
            ruleSuggestionId: updated.ruleSuggestionId,
            targetSystem: updated.targetSystem,
            entitlementKey: updated.entitlementKey,
            revokedReason,
          },
        },
      });
      return updated;
    });

    return toOperatingRuleView(record);
  }

  async dismiss(
    id: string,
    governanceActorId: string,
    reviewNote?: string,
  ): Promise<RuleSuggestionView> {
    const existing = await this.prisma.ruleSuggestion.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Rule suggestion ${id} not found`);
    }

    const normalizedReviewNote = reviewNote ?? null;
    const dismissed = await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.ruleSuggestion.updateMany({
        where: { id, status: 'PROPOSED' },
        data: {
          status: 'DISMISSED',
          reviewedBy: governanceActorId,
          reviewedAt: new Date(),
          reviewNote: normalizedReviewNote,
        },
      });
      if (transitioned.count === 0) {
        throw new ConflictException(
          `Rule suggestion ${id} is not awaiting review (status=${existing.status})`,
        );
      }

      const updated = await tx.ruleSuggestion.findUniqueOrThrow({
        where: { id },
      });
      await tx.auditLog.create({
        data: {
          eventType: 'RULE_SUGGESTION_DISMISSED',
          actor: governanceActorId,
          payload: {
            ruleSuggestionId: updated.id,
            patternType: updated.patternType,
            targetSystem: updated.targetSystem,
            entitlementKey: updated.entitlementKey,
            supportingDecisionIds: updated.supportingDecisionIds,
            reviewNote: normalizedReviewNote,
          },
        },
      });
      return updated;
    });

    return toRuleSuggestionView(dismissed);
  }
}
