import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Restricts baseline amendment to ADMIN. Local to this module rather than a
 * shared `auth/` guard: the existing auth module has no `@Roles()` decorator
 * or RolesGuard today (every other controller only checks `JwtAuthGuard`,
 * i.e. "is logged in", not "is this role"), and adding one there would be a
 * change to an existing, already-complete module. `JwtStrategy.validate`
 * already puts `role` on `req.user` (from the JWT payload), so this guard
 * only has to read it — it does not need its own auth logic.
 */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.user?.role;
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only a System Administrator may amend a locked baseline');
    }
    return true;
  }
}
