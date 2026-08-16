import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Restricts baseline amendment to the firm's administrators.
 *
 * Kept as a local guard rather than folded into the shared
 * `common/auth/roles.guard`, because the message it raises is specific to
 * amending a locked baseline. `JwtStrategy.validate` puts `role` on `req.user`
 * (from the JWT payload), so this guard only has to read it.
 *
 * Accepts SUPER_ADMIN as well as ADMIN: ADMIN is the pre-rename spelling, and
 * rows created before the Super Admin tier existed still carry it. Dropping it
 * would lock those accounts out of a capability they already had.
 */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.user?.role;
    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
      throw new ForbiddenException('Only a System Administrator may amend a locked baseline');
    }
    return true;
  }
}
