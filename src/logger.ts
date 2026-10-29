export type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly level: LogLevel = "info") {}

  debug(message: string, details?: unknown): void {
    this.write("debug", message, details);
  }

  info(message: string, details?: unknown): void {
    this.write("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.write("error", message, details);
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    if (levels[level] < levels[this.level]) return;

    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      message,
    };
    if (details !== undefined) entry.details = details;

    const output = JSON.stringify(entry);
    if (level === "error" || level === "warn") {
      process.stderr.write(`${output}\n`);
    } else {
      process.stdout.write(`${output}\n`);
    }
  }
}
