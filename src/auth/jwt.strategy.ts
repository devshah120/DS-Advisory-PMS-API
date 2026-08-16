import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '../config/config.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('jwtSecret'),
    });
  }

  /**
   * Whatever this returns becomes `req.user` — and therefore the `Actor` every
   * ownership filter is built from. Any field the scope rule needs must be
   * present here, or the filter silently degrades: a missing `role` would strip
   * a Super Admin down to a manager, and a missing `clientId` would leave a
   * client-portal login unable to see its own mandate.
   */
  async validate(payload: any) {
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      // Null for staff logins; set for a client-portal VIEWER. Tokens issued
      // before this claim existed simply have no key, which reads as null and
      // scopes that (staff) session correctly.
      clientId: payload.clientId ?? null,
    };
  }
}
