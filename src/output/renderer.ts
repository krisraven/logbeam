import chalk from 'chalk';
import type { LogEntry, LogLevel } from '../core/parser.js';

const LEVEL_COLOURS: Record<LogLevel, (s: string) => string> = {
  error: chalk.red.bold,
  warn:  chalk.yellow.bold,
  info:  chalk.cyan,
  debug: chalk.gray,
  trace: chalk.magenta,
  unknown: chalk.white,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  error: 'ERR',
  warn:  'WRN',
  info:  'INF',
  debug: 'DBG',
  trace: 'TRC',
  unknown: '---',
};

export function renderEntry(entry: LogEntry): string {
  const colour = LEVEL_COLOURS[entry.level];
  const label = colour(`[${LEVEL_LABELS[entry.level]}]`);
  const ts = entry.timestamp ? chalk.dim(entry.timestamp) + ' ' : '';
  const msg = entry.level === 'error'
    ? chalk.red(entry.message)
    : entry.level === 'warn'
    ? chalk.yellow(entry.message)
    : entry.message;

  const metaEntries = Object.entries(entry.meta);
  const metaStr = metaEntries.length > 0
    ? '  ' + metaEntries.map(([k, v]) => chalk.dim(`${k}=${v}`)).join('  ')
    : '';

  return `${ts}${label} ${msg}${metaStr}`;
}
