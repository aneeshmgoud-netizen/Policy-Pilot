import { Injectable } from '@nestjs/common';
import { AgentOperatingRule } from '../agent/agent.types';
import { PrismaService } from '../prisma/prisma.service';

export interface RetrievedOperatingRule {
  id: string;
  targetSystem: string;
  entitlementKey: string;
  patternType: string;
  guidance: string;
  approvedAt: Date;
}

/**
 * Project a retrieved rule onto what the agent may read. Mirrors
 * toAgentPrecedent, and exists for the same reason: one shared projection so
 * the worker and the evaluation harness cannot drift into showing the model
 * different things.
 *
 * approvedAt is forwarded as a date so the model can weigh recency; the
 * approver's identity is deliberately not, since who signed a rule is an
 * audit fact for humans, not an input that should sway a recommendation.
 */
export function toAgentOperatingRule(
  rule: RetrievedOperatingRule,
): AgentOperatingRule {
  return {
    id: rule.id,
    guidance: rule.guidance,
    approvedAt:
      rule.approvedAt instanceof Date
        ? rule.approvedAt.toISOString()
        : String(rule.approvedAt),
  };
}

/**
 * Reads governance-approved operating rules for a request's exact scope.
 *
 * Unlike precedent retrieval there is no embedding, no similarity ranking and
 * no limit: a rule is scoped to one (targetSystem, entitlementKey) pair, so
 * equality answers "does this rule apply here" completely. That makes the
 * lookup deterministic and fully explainable to a reviewer — there is no
 * "why did this rule surface" question to answer beyond the scope match.
 *
 * Only ACTIVE rules are ever returned, so revocation is the rollback path and
 * takes effect on the very next request, with no deployment. This is the same
 * contract PrecedentRetrievalService enforces for ACTIVE precedents.
 */
@Injectable()
export class OperatingRuleRetrievalService {
  constructor(private readonly prisma: PrismaService) {}

  async retrieveApplicableRules(
    targetSystem: string,
    entitlementKey: string,
  ): Promise<RetrievedOperatingRule[]> {
    const rules = await this.prisma.operatingRule.findMany({
      where: { targetSystem, entitlementKey, status: 'ACTIVE' },
      // Oldest first: a rule that has governed this scope longest is the
      // established one, and stable ordering keeps prompts reproducible.
      orderBy: { approvedAt: 'asc' },
      select: {
        id: true,
        targetSystem: true,
        entitlementKey: true,
        patternType: true,
        guidance: true,
        approvedAt: true,
      },
    });
    return rules;
  }
}
