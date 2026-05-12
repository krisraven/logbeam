#!/usr/bin/env node
import * as fs from 'fs';
import * as tty from 'tty';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { loadEntries, readLines } from './input.js';
import { streamStdin, tailFile } from './stream.js';
import { detectFormat } from './parser.js';
import { parseRelativeDuration, parseLevel, SEVERITY } from './filters.js';
import { App } from './tui.js';
import type { LiveBuffer } from './tui.js';
import type { LogEntry } from './parser.js';

const BUFFER_CAP = 10000;

function applyPreFilters(entries: LogEntry[], opts: { level?: string; since?: string }): LogEntry[] {
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

const program = new Command();

program
  .name('logbeam')
  .description('Pretty-print and interactively search log output')
  .version('0.1.0')
  .argument('[file]', 'log file to read (omit to read from stdin)')
  .option('--level <level>', 'minimum log level to show (trace|debug|info|warn|error)')
  .option('--since <duration>', 'only show logs from the last duration e.g. 10m, 1h, 2d')
  .action(async (file?: string, opts: { level?: string; since?: string } = {}) => {
    if (!process.stdout.isTTY) {
      await readLines(file);
      return;
    }

    // When stdin is piped, reopen /dev/tty so ink can still capture keyboard input.
    // Falls back to pipe mode if /dev/tty is unavailable (e.g. Windows).
    let inkStdin: NodeJS.ReadStream = process.stdin;
    if (!process.stdin.isTTY) {
      try {
        const fd = fs.openSync('/dev/tty', 'r+');
        inkStdin = new tty.ReadStream(fd);
      } catch {
        await readLines(file);
        return;
      }
    }

    const buffer: LiveBuffer = { entries: [] };

    if (file) {
      const all = await loadEntries(file);
      buffer.entries = applyPreFilters(all, opts);
      const startPosition = fs.statSync(file).size;
      const format = detectFormat(all.slice(0, 10).map(e => e.raw));

      render(React.createElement(App, { buffer, streaming: true }), { stdin: inkStdin });

      tailFile(file, startPosition, format, (newEntries) => {
        const filtered = applyPreFilters(newEntries, opts);
        buffer.entries = [...buffer.entries, ...filtered].slice(-BUFFER_CAP);
      });
    } else {
      const all = await loadEntries();
      buffer.entries = applyPreFilters(all, opts);
      render(React.createElement(App, { buffer, streaming: false }), { stdin: inkStdin });
    }
  });

program.parse();
