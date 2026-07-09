import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Stream-auth secret hygiene: the challenge/token endpoints have
  // request/response objects that can carry a bearer token. Redacting these
  // paths blanket-replaces matching keys with `[Redacted]` in every log entry
  // — defends against an accidental `logger.info({req})` or `{token}` from
  // ever surfacing the raw value.
  redact: {
    paths: [
      'token',
      '*.token',
      'req.headers.authorization',
      'req.headers.Authorization',
      'headers.authorization',
      'headers.Authorization',
    ],
    censor: '[Redacted]',
    remove: false,
  },
});

export function formatError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
