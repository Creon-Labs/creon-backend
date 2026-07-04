import { IsNotEmpty, IsString, Matches } from 'class-validator';

/** The wallet-signed `changeTrust` transaction envelope, base64 XDR. */
export class SubmitTrustlineDto {
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'walletAddress must be a valid Stellar public key',
  })
  walletAddress!: string;

  @IsString()
  @IsNotEmpty()
  signedXdr!: string;
}
