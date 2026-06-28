import { IsString, Length } from 'class-validator';

export class RejectKycDto {
  /** Reason shown to the entrepreneur so they can fix and re-submit. */
  @IsString()
  @Length(1, 500)
  reason!: string;
}
