import { IsString, Length } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(56, 56)
  walletAddress!: string;

  /** Base64-encoded signature over the challenge message. */
  @IsString()
  signature!: string;
}
