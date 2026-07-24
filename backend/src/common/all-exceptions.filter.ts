import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { redactPiiInText } from './pii.util';

// Global exception filter guaranteeing that no unexpected error ever leaks a
// stack trace or internal detail to the client. HttpExceptions (including the
// ValidationPipe's 400s and the API guard's 401s) pass through with their
// intended, already-safe response body. Anything else is logged server-side
// and returned as an opaque 500 so implementation details never reach callers.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response
        .status(status)
        .json(
          typeof body === 'string' ? { statusCode: status, message: body } : body,
        );
      return;
    }

    // Masked defensively: an unanticipated error (e.g. a raw DB constraint
    // message) could otherwise carry an EMP-/CC- identifier straight into logs.
    const detail = exception instanceof Error ? exception.stack : String(exception);
    this.logger.error('Unhandled exception', redactPiiInText(detail ?? ''));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
