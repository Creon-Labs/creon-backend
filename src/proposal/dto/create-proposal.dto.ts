import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One milestone an entrepreneur defines up front. No dates — release is
 * event-driven (the entrepreneur submits a milestone when ready). The per-milestone
 * `amount`s must sum exactly to the proposal's `requestedAmount`; that sum is pinned
 * on-chain at campaign deploy.
 */
export class CreateMilestoneDto {
  @IsInt()
  @Min(1)
  order!: number;

  @IsString()
  @Length(1, 255)
  title!: string;

  @IsString()
  @Length(1, 5000)
  description!: string;

  /** Money string (Decimal(28,7)); non-negative, up to 7 decimals. */
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'milestone amount must be a positive number with up to 7 decimals',
  })
  amount!: string;
}

/** Fields an entrepreneur provides to create a funding proposal (off-chain). */
export class CreateProposalDto {
  @IsString()
  @Length(1, 255)
  businessName!: string;

  @IsString()
  @Length(1, 5000)
  businessDescription!: string;

  @IsString()
  @Length(1, 100)
  category!: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  location?: string;

  /**
   * Money as a string — the column is Decimal(28,7) and a JS number cannot
   * safely hold that precision. Non-negative, up to 7 decimals; the service
   * additionally rejects zero.
   */
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'requestedAmount must be a positive number with up to 7 decimals',
  })
  requestedAmount!: string;

  /** Funding window, beginning when the on-chain campaign is deployed. */
  @IsInt()
  @Min(1)
  @Max(90)
  fundingDurationDays!: number;

  @IsInt()
  @Min(1)
  @Max(3650)
  lockPeriodDays!: number;

  /** Milestone schedule; amounts must sum to `requestedAmount` (validated in the service). */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateMilestoneDto)
  milestones!: CreateMilestoneDto[];
}
