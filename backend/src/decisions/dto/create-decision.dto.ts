import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const DECISION_OUTCOMES = ['GRANT', 'DENY'] as const;
export type DecisionOutcomeValue = (typeof DECISION_OUTCOMES)[number];

export const PRECEDENT_REASON_CODES = [
  'CONFIRMS_POLICY',
  'POLICY_MISAPPLIED',
  'MISSING_CONTEXT',
  'BUSINESS_EXCEPTION',
  'PRECEDENT_CONFLICT',
  'OTHER',
] as const;
export type PrecedentReasonCodeValue = (typeof PRECEDENT_REASON_CODES)[number];

export class CreateDecisionDto {
  // The reviewer's final, unambiguous effect on the entitlement. Whether
  // this counts as an override of the AI recommendation (and therefore
  // requires a rationale) depends on the request's actual recommendation,
  // which the DTO can't see — that check happens in DecisionsService, not
  // here, so a client can't self-report "not an override" to dodge it.
  @IsIn(DECISION_OUTCOMES, {
    message: 'outcome must be one of: GRANT, DENY',
  })
  outcome!: DecisionOutcomeValue;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  rationale?: string;

  // REQUIRED. The brief asks the system to preserve "why the recommendation
  // was accepted or changed" — accepted included — so agreement has to be
  // explained too, not just disagreement. While this was optional a reviewer
  // could close a request having recorded nothing about their reasoning, which
  // also meant the case could never become usable precedent: the summary a
  // precedent is retrieved by is built from this reason code.
  @IsIn(PRECEDENT_REASON_CODES, {
    message:
      'reasonCode must be one of: ' + PRECEDENT_REASON_CODES.join(', '),
  })
  reasonCode!: PrecedentReasonCodeValue;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  missingContext?: string;

  @IsOptional()
  @IsBoolean()
  precedentEligible?: boolean;
}
