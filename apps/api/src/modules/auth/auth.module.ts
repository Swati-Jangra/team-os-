import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailTokenService } from './email-token.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, EmailTokenService],
  exports: [SessionService, PasswordService],
})
export class AuthModule {}
