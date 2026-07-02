import { IsEnum } from 'class-validator';
import { VoteChoice } from '../../../generated/prisma/enums';

/** An investor's ballot on a milestone release — APPROVE or REJECT. */
export class CastVoteDto {
  @IsEnum(VoteChoice)
  choice!: VoteChoice;
}
