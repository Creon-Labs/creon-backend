import {
  IsDateString,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/** Identity fields submitted alongside the KTP/selfie images. */
export class SubmitKycDto {
  @IsString()
  @Length(1, 255)
  fullName!: string;

  /** Indonesian NIK — exactly 16 digits. Unique per person (anti-Sybil). */
  @IsString()
  @Matches(/^\d{16}$/, { message: 'nationalId must be a 16-digit NIK' })
  nationalId!: string;

  /** ISO date (YYYY-MM-DD). Optional. */
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;
}
