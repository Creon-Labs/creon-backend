import { IsNotEmpty, IsString } from 'class-validator';

/** The investor-signed `invest()` transaction envelope, base64 XDR. */
export class SubmitInvestmentDto {
  @IsString()
  @IsNotEmpty()
  signedXdr!: string;
}
