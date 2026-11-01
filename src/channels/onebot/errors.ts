export type OneBotErrorCode = 'ONEBOT_NOT_CONNECTED' | 'ONEBOT_ACTION_TIMEOUT' | 'ONEBOT_CONNECTION_CLOSED'
  | 'ONEBOT_WRITE_FAILED' | 'ONEBOT_SEND_REJECTED' | 'ONEBOT_SEND_UNCONFIRMED';

const messages: Record<OneBotErrorCode, string> = {
  ONEBOT_NOT_CONNECTED: 'websocket transport is not connected',
  ONEBOT_ACTION_TIMEOUT: 'OneBot action timed out',
  ONEBOT_CONNECTION_CLOSED: 'websocket closed before OneBot acknowledgement',
  ONEBOT_WRITE_FAILED: 'OneBot action write failed',
  ONEBOT_SEND_REJECTED: 'OneBot send was not acknowledged (rejected)',
  ONEBOT_SEND_UNCONFIRMED: 'OneBot send was not acknowledged (missing message ID)',
};

/** No provider wording or transport exception text. Callers can distinguish uncertain delivery from rejection. */
export class OneBotActionError extends Error {
  constructor(readonly code: OneBotErrorCode, readonly deliveryUnknown = false, readonly retcode?: number) {
    super(messages[code]);
    this.name = 'OneBotActionError';
  }
}
