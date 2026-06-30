import { IsString, Length } from 'class-validator';

export class RevokeKycDto {
  /** Why the previously-approved KYC is being revoked (expiry/sanction). */
  @IsString()
  @Length(1, 500)
  reason!: string;
}
