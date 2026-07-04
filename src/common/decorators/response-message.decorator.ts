import { SetMetadata } from '@nestjs/common';
import { RESPONSE_MESSAGE_KEY } from '../constants/response-message.constants';

/**
 * Set the human-readable `message` returned in the success envelope
 * (`{ statusCode, message, data }`) for this handler. Read by
 * `ResponseEnvelopeInterceptor` via `Reflector`. Handlers without this
 * decorator fall back to `DEFAULT_RESPONSE_MESSAGE` ("Success") rather than
 * crashing or emitting `undefined`.
 *
 * No-op on a `204 No Content` handler (e.g. `logout`) — the interceptor never
 * reads it there, since a 204 response has no body to put a message in.
 */
export const ResponseMessage = (message: string) =>
  SetMetadata(RESPONSE_MESSAGE_KEY, message);
