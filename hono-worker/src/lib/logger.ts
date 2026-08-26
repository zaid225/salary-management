// No pino here - pino's transports rely on Node APIs (worker_threads,
// filesystem) that don't exist on Workers. Structured JSON via console.*
// is what Workers Logs actually parses (error-handling-logging.md rule 2).
type LogFields = Record<string, unknown>;

function line(level: string, fields: LogFields, msg: string): void {
  const payload = JSON.stringify({ level, msg, ...fields, time: Date.now() });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

export const logger = {
  info: (fields: LogFields, msg: string) => line("info", fields, msg),
  warn: (fields: LogFields, msg: string) => line("warn", fields, msg),
  error: (fields: LogFields, msg: string) => line("error", fields, msg),
};
