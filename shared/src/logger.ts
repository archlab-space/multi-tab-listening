import winston from 'winston'

/**
 * The one logger factory for the workspace.
 *
 * Both formats that grew up independently are kept, each where it belongs:
 * `printf` for the console, because a human is reading it, and `json` for the
 * file, because a machine is.
 */
export function createLogger(filename: string, level?: string): winston.Logger {
  return winston.createLogger({
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.File({ filename }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const rest = Object.keys(meta).length
              ? ` ${JSON.stringify(meta)}`
              : ''
            return `${timestamp} [${level}]: ${message}${rest}`
          }),
        ),
      }),
    ],
  })
}
