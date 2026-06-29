import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

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

  @IsInt()
  @Min(1)
  @Max(3650)
  lockPeriodDays!: number;
}
