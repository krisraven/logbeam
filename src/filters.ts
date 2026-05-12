import type { LogLevel } from './parser.js';

export const SEVERITY: Record<LogLevel, number> = {
  trace: 0, debug: 1, info: 2, warn: 3, error: 4, unknown: -1,
};

export function parseRelativeDuration(str: string): Date | null {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = unit === 's' ? amount * 1000
    : unit === 'm' ? amount * 60_000
    : unit === 'h' ? amount * 3_600_000
    : amount * 86_400_000;
  return new Date(Date.now() - ms);
}

export function parseLevel(str: string): LogLevel | null {
  const valid: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
  const lower = str.toLowerCase() as LogLevel;
  return valid.includes(lower) ? lower : null;
}
