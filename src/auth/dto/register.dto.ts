import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';

/** Roles a user may self-assign at registration (ADMIN is seed-only). */
export const SELF_ASSIGNABLE_ROLES = ['ENTREPRENEUR', 'INVESTOR'] as const;
export type SelfAssignableRole = (typeof SELF_ASSIGNABLE_ROLES)[number];

export class RegisterDto {
  @IsString()
  @Length(56, 56)
  walletAddress!: string;

  /** Base64-encoded SEP-53 signature over the challenge message. */
  @IsString()
  signature!: string;

  @IsIn(SELF_ASSIGNABLE_ROLES)
  role!: SelfAssignableRole;

  /** Required for entrepreneurs; validated as an email whenever provided. */
  @ValidateIf((o: RegisterDto) => o.role === 'ENTREPRENEUR' || o.email != null)
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}
