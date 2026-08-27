#!/usr/bin/env node
import * as fs from 'fs';
import * as tty from 'tty';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { loadEntries, readLines } from './io/input.js';
import { streamStdin, tailFile } from './io/stream.js';
import { tailCloudWatchLogGroup } from './io/cloudwatch.js';
import { detectFormat } from './core/parser.js';
import { parseRelativeDuration, parseLevel, SEVERITY } from './core/filters.js';
import { App } from './output/tui.js';
import type { LiveBuffer } from './output/tui.js';
import type { LogEntry } from './core/parser.js';
import { BUFFER_CAP } from './constants.js';

interface PreFilterOptions {
  level?: string;
  since?: string;
}

interface CliOptions extends PreFilterOptions {
  group?: string;
  stream?: string;
  region?: string;
}

function applyPreFilters(entries: LogEntry[], opts: PreFilterOptions): LogEntry[] {
  let result = entries;

  if (opts.level) {
    const minLevel = parseLevel(opts.level);
    if (minLevel) {
      const minSeverity = SEVERITY[minLevel];
      result = result.filter(e => SEVERITY[e.level] >= minSeverity);
    }
  }

  if (opts.since) {
    const threshold = parseRelativeDuration(opts.since);
    if (threshold) {
      result = result.filter(e => {
        if (!e.timestamp) return true;
        return new Date(e.timestamp) >= threshold;
      });
    }
  }

  return result;
}

// When stdin is piped, reopen /dev/tty so ink can still capture keyboard input.
// Returns null if /dev/tty is unavailable (e.g. Windows), signalling callers to fall back to pipe mode.
function resolveInkStdin(): NodeJS.ReadStream | null {
  if (process.stdin.isTTY) return process.stdin;
  try {
    const fd = fs.openSync('/dev/tty', 'r+');
    return new tty.ReadStream(fd);
  } catch {
    return null;
  }
}

function startInteractiveApp(inkStdin: NodeJS.ReadStream, initialEntries: LogEntry[] = []): LiveBuffer {
  const buffer: LiveBuffer = { entries: initialEntries };
  render(React.createElement(App, { buffer, streaming: true }), { stdin: inkStdin });
  return buffer;
}

async function runFileMode(file: string, opts: PreFilterOptions, inkStdin: NodeJS.ReadStream): Promise<void> {
  const all = await loadEntries(file);
  const startPosition = fs.statSync(file).size;
  const format = detectFormat(all.slice(0, 10).map(e => e.raw));

  const buffer = startInteractiveApp(inkStdin, applyPreFilters(all, opts));

  tailFile(file, startPosition, format, (newEntries) => {
    const filtered = applyPreFilters(newEntries, opts);
    buffer.entries = [...buffer.entries, ...filtered].slice(-BUFFER_CAP);
  });
}

function runStdinMode(opts: PreFilterOptions, inkStdin: NodeJS.ReadStream): void {
  if (process.stdin.isTTY) {
    console.error('Error: specify a log file or pipe log data to logbeam\nUsage: logbeam <file>  |  cat app.log | logbeam');
    process.exit(1);
  }

  const buffer = startInteractiveApp(inkStdin);
  streamStdin((newEntries) => {
    const filtered = applyPreFilters(newEntries, opts);
    buffer.entries = [...buffer.entries, ...filtered].slice(-BUFFER_CAP);
  });
}

function cloudWatchStartTime(opts: CliOptions): number | undefined {
  if (!opts.since) return undefined;
  return parseRelativeDuration(opts.since)?.getTime();
}

function runCloudWatchMode(opts: CliOptions, inkStdin: NodeJS.ReadStream): void {
  const buffer = startInteractiveApp(inkStdin);
  tailCloudWatchLogGroup(
    opts.group!,
    {
      region: opts.region,
      streamNamePrefix: opts.stream,
      startTime: cloudWatchStartTime(opts),
    },
    (newEntries) => {
      const filtered = applyPreFilters(newEntries, opts);
      buffer.entries = [...buffer.entries, ...filtered].slice(-BUFFER_CAP);
    },
    (err) => {
      console.error(`CloudWatch tail error: ${err.message}`);
    },
  );
}

async function printCloudWatchMode(opts: CliOptions): Promise<void> {
  const { renderEntry } = await import('./output/renderer.js');
  await new Promise<void>(() => {
    tailCloudWatchLogGroup(
      opts.group!,
      {
        region: opts.region,
        streamNamePrefix: opts.stream,
        startTime: cloudWatchStartTime(opts),
      },
      (newEntries) => {
        const filtered = applyPreFilters(newEntries, opts);
        for (const entry of filtered) process.stdout.write(renderEntry(entry) + '\n');
      },
      (err) => {
        console.error(`CloudWatch tail error: ${err.message}`);
      },
    );
  });
}

async function main(file: string | undefined, opts: CliOptions): Promise<void> {
  if (opts.group && file) {
    console.error('Error: --group cannot be combined with a file argument');
    process.exit(1);
  }
  if (opts.stream && !opts.group) {
    console.error('Error: --stream requires --group');
    process.exit(1);
  }

  if (opts.group) {
    if (!process.stdout.isTTY) {
      await printCloudWatchMode(opts);
      return;
    }
    const inkStdin = resolveInkStdin();
    if (!inkStdin) {
      await printCloudWatchMode(opts);
      return;
    }
    runCloudWatchMode(opts, inkStdin);
    return;
  }

  if (!process.stdout.isTTY) {
    await readLines(file);
    return;
  }

  const inkStdin = resolveInkStdin();
  if (!inkStdin) {
    await readLines(file);
    return;
  }

  if (file) {
    await runFileMode(file, opts, inkStdin);
  } else {
    runStdinMode(opts, inkStdin);
  }
}

const program = new Command();

program
  .name('logbeam')
  .description('Pretty-print and interactively search log output')
  .argument('[file]', 'log file to read (omit to read from stdin)')
  .option('--level <level>', 'minimum log level to show (trace|debug|info|warn|error)')
  .option('--since <duration>', 'only show logs from the last duration e.g. 10m, 1h, 2d')
  .option('--group <name>', 'tail a CloudWatch log group directly (no aws CLI required)')
  .option('--stream <name>', 'restrict --group to log streams with this name prefix')
  .option('--region <region>', 'AWS region (defaults to the standard AWS SDK/CLI resolution chain)')
  .action((file?: string, opts: CliOptions = {}) => main(file, opts));

program.parse();
