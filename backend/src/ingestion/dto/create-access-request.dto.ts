import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// Field names mirror the upstream webhook's wire format (snake_case) rather
// than our internal camelCase convention, so the DTO documents exactly what
// callers must send. Mapping to the AccessRequest persistence shape happens
// in the service layer.

// The only request type this self-service access-review flow ingests today.
// Kept as an exported const so the allow-list is a single source of truth and
// trivially extensible if the upstream contract adds types later.
export const ACCESS_REQUEST_TYPES = ['GRANT_ENTITLEMENT'] as const;

export class RequesterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  department!: string;

  @IsString()
  @MaxLength(50)
  @Matches(/^CC-[A-Z0-9-]+$/, {
    message: 'cost_center must match the CC-XXXXX format',
  })
  cost_center!: string;
}

export class TargetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  system_name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  entitlement_key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  justification!: string;
}

export class CreateAccessRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  request_id!: string;

  @IsString()
  @MaxLength(50)
  @Matches(/^EMP-\d+$/, {
    message: 'employee_id must match the EMP-XXXXX format',
  })
  employee_id!: string;

  @IsString()
  @IsIn(ACCESS_REQUEST_TYPES, {
    message: `request_type must be one of: ${ACCESS_REQUEST_TYPES.join(', ')}`,
  })
  request_type!: string;

  @IsISO8601()
  timestamp!: string;

  @ValidateNested()
  @Type(() => RequesterDto)
  requester!: RequesterDto;

  @ValidateNested()
  @Type(() => TargetDto)
  target!: TargetDto;
}
