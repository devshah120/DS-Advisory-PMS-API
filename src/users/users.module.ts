import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { SecurityService } from './security.service';
import { UsersController } from './users.controller';
import { PrismaModule } from '../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
  providers: [UsersService, SecurityService],
  // SecurityService is exported because AuthService needs it at login: to check
  // a TOTP code, consume a recovery code, and record the new session.
  exports: [UsersService, SecurityService],
})
export class UsersModule {}
