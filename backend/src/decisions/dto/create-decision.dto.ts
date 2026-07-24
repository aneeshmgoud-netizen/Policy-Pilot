import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const HUMAN_DECISION_TYPES = ['APPROVE', 'DENY', 'OVERRIDE'] as const;
export type HumanDecisionTypeValue = (typeof HUMAN_DECISION_TYPES)[number];

export class CreateDecisionDto {
  @IsIn(HUMAN_DECISION_TYPES, {
    message: 'decisionType must be one of: APPROVE, DENY, OVERRIDE',
  })
  decisionType!: HumanDecisionTypeValue;

  // Override is a reviewer deviating from the AI recommendation, so it MUST
  // carry a rationale. ValidateIf applies the string/non-empty rules only when
  // the decision is OVERRIDE; for APPROVE/DENY the rationale is optional. The
  // same rule is also enforced by a DB CHECK constraint as the final backstop.
  // Trim first so a whitespace-only rationale ("   ") is treated as empty and
  // rejected for OVERRIDE, rather than sneaking past @IsNotEmpty.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o) => o.decisionType === 'OVERRIDE')
  @IsString()
  @IsNotEmpty({ message: 'rationale is required when decisionType is OVERRIDE' })
  @MaxLength(2000)
  rationale?: string;
}
