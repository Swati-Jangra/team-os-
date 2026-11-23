import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@teamos/shared';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

/** Single place that turns every failure into the documented error envelope. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = req.id;

    let status: number;
    let code: ErrorCode;
    let message: string;
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
      const retry = (details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
      if (code === 'RATE_LIMITED' && typeof retry === 'number') res.setHeader('Retry-After', String(retry));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_TO_CODE[status] ?? 'INTERNAL';
      message = status === 404 ? ERROR_CODES.NOT_FOUND.message : exception.message;
    } else if (isBodyParserError(exception)) {
      // body-parser (raw/json) errors such as payload too large
      status = exception.status;
      code = status === 413 ? 'VALIDATION_FAILED' : STATUS_TO_CODE[status] ?? 'VALIDATION_FAILED';
      message = status === 413 ? 'The request body is too large.' : 'Invalid request body.';
    } else {
      status = 500;
      code = 'INTERNAL';
      message = ERROR_CODES.INTERNAL.message; // never leak internals
      this.logger.error(
        `Unhandled error [${requestId}] ${req.method} ${req.url}: ${
          exception instanceof Error ? exception.stack ?? exception.message : String(exception)
        }`,
      );
    }

    const body: ApiErrorBody = { error: { code, message, requestId } };
    if (details !== undefined && status < 500) body.error.details = details;
    res.status(status).json(body);
  }
}

function isBodyParserError(e: unknown): e is { status: number; type: string } {
  const x = e as { status?: unknown; type?: unknown } | null;
  return !!x && typeof x.status === 'number' && x.status >= 400 && x.status < 500 && typeof x.type === 'string' && x.type.startsWith('entity.');
}
