import { Matches } from 'class-validator';

/** The wallet claiming a test-USDC top-up from the faucet. */
export class ClaimFaucetDto {
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'walletAddress must be a valid Stellar public key',
  })
  walletAddress!: string;
}
