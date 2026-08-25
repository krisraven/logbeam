#!/usr/bin/env node
import * as fs from 'fs';
import * as tty from 'tty';
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { loadEntries, readLines } from './io/input.js';
import { streamStdin, tailFile } from './io/stream.js';
import { detectFormat } from './core/parser.js';
import { parseRelativeDuration, parseLevel, SEVERITY } from './core/filters.js';
import { App } from './output/tui.js';
import { BUFFER_CAP } from './constants.js';
function applyPreFilters(entries, opts) {
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
                if (!e.timestamp)
                    return true;
                return new Date(e.timestamp) >= threshold;
            });
        }
    }
    return result;
}
// When stdin is piped, reopen /dev/tty so ink can still capture keyboard input.
// Returns null if /dev/tty is unavailable (e.g. Windows), signalling callers to fall back to pipe mode.
function resolveInkStdin() {
    if (process.stdin.isTTY)
        return process.stdin;
    try {
        const fd = fs.openSync('/dev/tty', 'r+');
        return new tty.ReadStream(fd);
    }
    catch {
        return null;
    }
}
function startInteractiveApp(inkStdin, initialEntries = []) {
    const buffer = { entries: initialEntries };
    render(React.createElement(App, { buffer, streaming: true }), { stdin: inkStdin });
    return buffer;
}
async function runFileMode(file, opts, inkStdin) {
    const all = await loadEntries(file);
    const startPosition = fs.statSync(file).size;
    const format = detectFormat(all.slice(0, 10).map(e => e.raw));
    const buffer = startInteractiveApp(inkStdin, applyPreFilters(all, opts));
    tailFile(file, startPosition, format, (newEntries) => {
        const filtered = applyPreFilters(newEntries, opts);
        buffer.entries = [...buffer.entries, ...filtered].slice(-BUFFER_CAP);
    });
}
function runStdinMode(opts, inkStdin) {
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
async function main(file, opts) {
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
    }
    else {
        runStdinMode(opts, inkStdin);
    }
}
const program = new Command();
program
    .name('logbeam')
    .description('Pretty-print and interactively search log output')
    .version('0.1.0')
    .argument('[file]', 'log file to read (omit to read from stdin)')
    .option('--level <level>', 'minimum log level to show (trace|debug|info|warn|error)')
    .option('--since <duration>', 'only show logs from the last duration e.g. 10m, 1h, 2d')
    .action((file, opts = {}) => main(file, opts));
program.parse();
