import { SetMetadata } from '@nestjs/common';
import { Role } from '../../../generated/prisma/enums';

/** Metadata key under which {@link Roles} stores the required roles. */
export const ROLES_KEY = 'roles';

/**
 * Restrict a route (or controller) to users holding at least one of the given
 * roles. Enforced by {@link RolesGuard}, which must run after {@link JwtAuthGuard}.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
