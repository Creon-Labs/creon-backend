import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorResponse } from '../interfaces/api-response.interface';

interface HttpExceptionBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
}

/**
 * Normalize every thrown error into the error envelope
 * `{ statusCode, message, error, data: null }`.
 *
 * `HttpException`s — thrown throughout services/guards as e.g.
 * `new NotFoundException('Campaign not found')` or by the global
 * `ValidationPipe` on class-validator failures — already carry a
 * `{ statusCode, message, error }` body via Nest's own
 * `HttpException.createBody`; this filter reuses that body as-is and only
 * adds `data: null`. It deliberately does not recompute the `error` reason
 * phrase itself, since Nest's built-in exceptions already supply it.
 *
 * Anything that is *not* an `HttpException` (an unhandled bug, a Prisma/driver
 * error that slipped through a service, etc.) is logged with its stack trace
 * and reported as a generic `500` without leaking internals to the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.buildBody(exception);
    response.status(body.statusCode).json(body);
  }

  private buildBody(exception: unknown): ApiErrorResponse {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        return {
          statusCode: status,
          message: payload,
          error: exception.name,
          data: null,
        };
      }

      const body = payload as HttpExceptionBody;
      return {
        statusCode: body.statusCode ?? status,
        message: body.message ?? exception.message,
        error: body.error ?? exception.name,
        data: null,
      };
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
      data: null,
    };
  }
}
