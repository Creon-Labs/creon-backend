import { IsString, Length } from 'class-validator';

export class CancelCampaignDto {
  /** Why the campaign is being cancelled — surfaced to investors alongside the refund. */
  @IsString()
  @Length(1, 500)
  reason!: string;
}
