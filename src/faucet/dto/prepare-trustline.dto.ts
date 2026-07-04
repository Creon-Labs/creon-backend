import { Matches } from 'class-validator';

/** The wallet requesting an unsigned USDC `changeTrust` transaction. */
export class PrepareTrustlineDto {
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'walletAddress must be a valid Stellar public key',
  })
  walletAddress!: string;
}
