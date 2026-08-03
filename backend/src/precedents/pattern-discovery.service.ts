import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma, RuleSuggestion } from '@prisma/client';
import { runContentFree } from '../common/operational-error.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  DecisionRecord,
  detectInconsistentDecisions,
  detectOutdatedPolicy,
  detectRecurringException,
  groupDecisionsByEntitlement,
  PatternCandidate,
} from './pattern-detection';

const PATTERN_DISCOVERY_INTERVAL_MS = 30 * 60_000;
const PATTERN_DISCOVERY_FAILED_CODE = 'PATTERN_DISCOVERY_FAILED';

@Injectable()
export class PatternDiscoveryService {
  private readonly logger = new Logger(PatternDiscoveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async discoverPatterns(): Promise<RuleSuggestion[]> {
    const [humanDecisions, activePrecedents, currentVersions] =
      await Promise.all([
        this.prisma.humanDecision.findMany({
          include: {
            accessRequest: {
              select: { targetSystem: true, entitlementKey: true },
            },
          },
        }),
        this.prisma.precedentRecord.findMany({
          where: { status: 'ACTIVE' },
          select: {
            targetSystem: true,
            entitlementKey: true,
            policyVersionSnapshot: true,
            decisionFeedback: { select: { humanDecisionId: true } },
          },
        }),
        this.prisma.policyDocument.findMany({
          select: { documentName: true, version: true },
        }),
      ]);

    const decisions: DecisionRecord[] = humanDecisions.map((decision) => ({
      humanDecisionId: decision.id,
      targetSystem: decision.accessRequest.targetSystem,
      entitlementKey: decision.accessRequest.entitlementKey,
      outcome: decision.outcome,
      overridesRecommendation: decision.overridesRecommendation,
    }));
    const groups = groupDecisionsByEntitlement(decisions);
    const candidates: PatternCandidate[] = [];

    for (const group of groups) {
      const groupPrecedents = activePrecedents
        .filter(
          (precedent) =>
            precedent.targetSystem === group.targetSystem &&
            precedent.entitlementKey === group.entitlementKey,
        )
        .map((precedent) => ({
          humanDecisionId: precedent.decisionFeedback.humanDecisionId,
          policyVersionSnapshot: precedent.policyVersionSnapshot,
        }));
      const detected = [
        detectInconsistentDecisions(group),
        detectRecurringException(group),
        detectOutdatedPolicy(group, groupPrecedents, currentVersions),
      ];
      candidates.push(
        ...detected.filter(
          (candidate): candidate is PatternCandidate => candidate !== null,
        ),
      );
    }

    const created: RuleSuggestion[] = [];
    for (const candidate of candidates) {
      try {
        created.push(
          await this.prisma.ruleSuggestion.create({
            data: {
              patternType: candidate.patternType,
              targetSystem: candidate.targetSystem,
              entitlementKey: candidate.entitlementKey,
              description: candidate.description,
              supportingDecisionIds: candidate.supportingDecisionIds,
              status: 'PROPOSED',
            },
          }),
        );
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          this.logger.log(
            `Rule suggestion already surfaced for ${candidate.patternType} ` +
              `${candidate.targetSystem}/${candidate.entitlementKey}; skipping duplicate.`,
          );
          continue;
        }
        throw error;
      }
    }

    return created;
  }

  @Interval(PATTERN_DISCOVERY_INTERVAL_MS)
  async scheduledDiscoverPatterns(): Promise<void> {
    // @Interval invokes this unawaited. Keep failures inside the application's
    // content-free boundary so a dependency error cannot become an unhandled
    // rejection or leak exception text into scheduler logs.
    const result = await runContentFree(PATTERN_DISCOVERY_FAILED_CODE, () =>
      this.discoverPatterns(),
    );
    if (!result.ok) {
      this.logger.warn(`Scheduled pattern discovery failed: ${result.code}.`);
    }
  }
}
