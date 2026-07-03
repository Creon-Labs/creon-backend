import { IsNotEmpty, IsString } from 'class-validator';

/** A client-signed `refund_claim()` transaction envelope (base64 XDR). */
export class SubmitRefundClaimDto {
  @IsString()
  @IsNotEmpty()
  signedXdr!: string;
}
