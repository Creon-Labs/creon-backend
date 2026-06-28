import { IsString, Length } from 'class-validator';

export class ChallengeDto {
  /** Stellar public key (G...), 56 characters. */
  @IsString()
  @Length(56, 56)
  walletAddress!: string;
}
