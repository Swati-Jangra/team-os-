import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  uuidSchema,
  verifyEmailSchema,
  type ForgotPasswordInput,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from '@teamos/validation';
import { AppError } from '@teamos/shared';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../common/app-config';
import { clientIp, CurrentUser, Public, RateLimit, SessionInfo } from '../../common/decorators';
import type { UserActor } from '../../common/actor';
import type { AuthedUser } from '../../common/express.d';
import { ZodPipe } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { CSRF_COOKIE, SESSION_COOKIE, SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @RateLimit({ limit: 10, windowSec: 3600 })
  @Post('register')
  register(@Body(new ZodPipe(registerSchema)) body: RegisterInput, @Req() req: Request) {
    return this.auth.register(body, { requestId: req.id, ip: clientIp(req) });
  }

  @Public()
  @RateLimit({ limit: 30, windowSec: 3600 })
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@Body(new ZodPipe(verifyEmailSchema)) body: VerifyEmailInput, @Req() req: Request) {
    return this.auth.verifyEmail(body, { requestId: req.id, ip: clientIp(req) });
  }

  @Public()
  @RateLimit({ limit: 10, windowSec: 300, scope: 'ip-email' })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, {
      requestId: req.id,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    });
    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: result.expiresAt,
    });
    // readable by the SPA so it can echo it in X-CSRF-Token; the server compares to the stored per-session value
    res.cookie(CSRF_COOKIE, result.csrfToken, {
      httpOnly: false,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: result.expiresAt,
    });
    return { user: result.user, csrfToken: result.csrfToken };
  }

  @HttpCode(200)
  @Post('logout')
  async logout(
    @SessionInfo() session: AuthedUser,
    @CurrentUser() actor: UserActor,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(session.sessionId, actor);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
    return { loggedOut: true };
  }

  @Public()
  @RateLimit({ limit: 5, windowSec: 3600, scope: 'ip-email' })
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body(new ZodPipe(forgotPasswordSchema)) body: ForgotPasswordInput, @Req() req: Request) {
    return this.auth.forgotPassword(body, { requestId: req.id, ip: clientIp(req) });
  }

  @Public()
  @RateLimit({ limit: 10, windowSec: 3600 })
  @HttpCode(200)
  @Post('reset-password')
  resetPassword(@Body(new ZodPipe(resetPasswordSchema)) body: ResetPasswordInput, @Req() req: Request) {
    return this.auth.resetPassword(body, { requestId: req.id, ip: clientIp(req) });
  }

  @Get('me')
  async me(@SessionInfo() session: AuthedUser) {
    const me = await this.auth.me(session.userId);
    return { ...me, csrfToken: session.csrfToken };
  }

  @Get('sessions')
  async listSessions(@SessionInfo() session: AuthedUser) {
    const rows = await this.sessions.listActive(session.userId);
    return rows.map((s) => ({ ...s, current: s.id === session.sessionId }));
  }

  @Delete('sessions/:id')
  async revokeSession(@SessionInfo() session: AuthedUser, @Param('id', new ZodPipe(uuidSchema)) id: string) {
    const revoked = await this.sessions.revoke(id, session.userId);
    if (!revoked) throw new AppError('NOT_FOUND');
    return { revoked: true };
  }
}
