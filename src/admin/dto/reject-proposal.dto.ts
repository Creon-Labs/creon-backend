import { IsString, Length } from 'class-validator';

export class RejectProposalDto {
  /** Reason shown to the entrepreneur so they can revise and re-submit. */
  @IsString()
  @Length(1, 500)
  reason!: string;
}
