import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

// Global exception filter guaranteeing that no unexpected error ever leaks a
// stack trace or internal detail to the client OR the application log.
// HttpExceptions (including the ValidationPipe's 400s and the API guard's
// 401s) pass through with their intended, already-safe response body — that
// API surface is designed to be exposed. Anything else is an unanticipated
// failure (a DB error, a downstream timeout, a bug): its message/stack/cause
// could carry a connection string, an internal hostname, a bearer token, or
// an employee ID, so the catch below deliberately never reads it. Only a
// stable code plus safe, request-shape metadata (method, route path — both
// server-defined, never user data) is logged.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

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

    const request = ctx.getRequest<Request>();
    this.logger.error(
      `UNHANDLED_EXCEPTION method=${request.method} route=${request.route?.path ?? request.path}`,
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
