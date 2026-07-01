import { IsString, Matches } from 'class-validator';

/** Profit (USDC) the business wants to deposit; backend builds `deposit_profit()`. */
export class DepositProfitDto {
  /**
   * Money as a string — the column is Decimal(28,7) and a JS number cannot safely
   * hold that precision. Non-negative, up to 7 decimals; the service additionally
   * rejects zero.
   */
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'amount must be a positive number with up to 7 decimals',
  })
  amount!: string;
}
