import { IsString, Matches } from 'class-validator';

/** Amount an investor wants to commit; backend builds the `invest()` tx from it. */
export class PrepareInvestmentDto {
  /**
   * Money as a string — the column is Decimal(28,7) and a JS number cannot
   * safely hold that precision. Non-negative, up to 7 decimals; the service
   * additionally rejects zero.
   */
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'amount must be a positive number with up to 7 decimals',
  })
  amount!: string;
}
