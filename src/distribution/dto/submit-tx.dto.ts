import { IsNotEmpty, IsString } from 'class-validator';

/** A client-signed transaction envelope (base64 XDR) — shared by the deposit and
 *  claim submit endpoints (`deposit_profit()` / `claim()`). */
export class SubmitTxDto {
  @IsString()
  @IsNotEmpty()
  signedXdr!: string;
}
