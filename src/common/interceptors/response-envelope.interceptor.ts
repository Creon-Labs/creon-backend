import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  DEFAULT_RESPONSE_MESSAGE,
  RESPONSE_MESSAGE_KEY,
} from '../constants/response-message.constants';
import type { ApiSuccessResponse } from '../interfaces/api-response.interface';

/**
 * Wrap every successful JSON response in `{ statusCode, message, data }`.
 * `message` comes from `@ResponseMessage(...)` on the handler (falling back
 * to `DEFAULT_RESPONSE_MESSAGE`); `statusCode` is read off the actual
 * response object rather than assumed, so it agrees with whatever Nest/
 * `@HttpCode` already settled on.
 *
 * Skips enveloping when there is no body to wrap:
 * - `204 No Content` (e.g. `POST /auth/logout`) must have a genuinely empty
 *   body — enveloping it would manufacture a body Nest never intended to send.
 * - A handler that returned `undefined`/`void`, even on a route that isn't
 *   literally 204, for the same reason.
 *
 * A legitimate business `null` (e.g. a campaign's refund lookup returning
 * `null` when it was never cancelled) is *not* skipped — `null` is real data,
 * wrapped as `{ statusCode: 200, message: '...', data: null }`, distinct from
 * a route with no body at all.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T> | T
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T> | T> {
    return next.handle().pipe(
      map((data) => {
        const response = context.switchToHttp().getResponse<Response>();
        const statusCode = response.statusCode;

        if (
          statusCode === Number(HttpStatus.NO_CONTENT) ||
          data === undefined
        ) {
          return data;
        }

        const message =
          this.reflector.getAllAndOverride<string | undefined>(
            RESPONSE_MESSAGE_KEY,
            [context.getHandler(), context.getClass()],
          ) ?? DEFAULT_RESPONSE_MESSAGE;

        return { statusCode, message, data };
      }),
    );
  }
}
