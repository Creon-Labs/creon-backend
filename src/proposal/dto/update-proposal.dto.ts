import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Partial edit of a DRAFT proposal — every field optional. Defined manually
 * rather than via PartialType (`@nestjs/mapped-types` is not a dependency).
 */
export class UpdateProposalDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  businessName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 5000)
  businessDescription?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  location?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'requestedAmount must be a positive number with up to 7 decimals',
  })
  requestedAmount?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  lockPeriodDays?: number;
}
