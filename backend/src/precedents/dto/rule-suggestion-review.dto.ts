import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RuleSuggestionReviewDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;

  // Optional, and only meaningful on accept. When supplied it becomes an
  // ACTIVE OperatingRule that future recommendations for this scope read —
  // this is the text that makes an accepted pattern actually influence later
  // requests. Accepting without it is allowed (an approver may simply be
  // acknowledging a pattern), but then nothing retrievable is created; the
  // response says so via operatingRuleId: null.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(10, {
    message:
      'guidance must be a usable instruction for reviewers, not a placeholder',
  })
  @MaxLength(2000)
  guidance?: string;
}

export class RevokeOperatingRuleDto {
  // Required: a revoked rule's reason is the audit record of why organizational
  // guidance was withdrawn. Mirrors RevokePrecedentDto.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'revokedReason is required to revoke an operating rule' })
  @MaxLength(2000)
  revokedReason!: string;
}
