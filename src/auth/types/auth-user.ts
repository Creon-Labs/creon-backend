import { Role } from '../../../generated/prisma/enums';

/** Authenticated principal attached to the request by {@link JwtAuthGuard}. */
export interface AuthUser {
  userId: string;
  roles: Role[];
}
