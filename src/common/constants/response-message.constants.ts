/** Metadata key under which {@link ResponseMessage} stores the success message. */
export const RESPONSE_MESSAGE_KEY = 'response_message';

/**
 * Fallback success message for a handler with no `@ResponseMessage(...)`.
 * Every handler should carry one — this exists so a missed decorator degrades
 * gracefully instead of shipping `undefined` in the response body.
 */
export const DEFAULT_RESPONSE_MESSAGE = 'Success';
