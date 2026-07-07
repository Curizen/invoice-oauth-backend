import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-internal-key"]',
      'res.headers["set-cookie"]',
      '*.token',
      '*.accessToken',
      '*.access_token',
      '*.refreshToken',
      '*.refresh_token',
      '*.secret',
      '*.clientSecret',
      '*.client_secret',
      '*.masterKeyHex',
    ],
    censor: '[REDACTED]',
  },
});
