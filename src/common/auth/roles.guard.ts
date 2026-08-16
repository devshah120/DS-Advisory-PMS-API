import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'required_roles';

/**
 * Restricts a route to the listed roles. Must be paired with `JwtAuthGuard`,
 * which is what puts `role` on `req.user` (read from the JWT payload) — this
 * guard only compares, it does not authenticate.
 *
 * Usage: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.SUPER_ADMIN)`.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Method-level `@Roles` wins over a controller-level one, so a controller
    // can set a floor and a single route can tighten it further.
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()]
    );

    // No decorator means the route is open to any authenticated user — the
    // JwtAuthGuard in front of this one has already done that check.
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const role = req.user?.role;

    if (!required.includes(role)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action'
      );
    }

    return true;
  }
}
