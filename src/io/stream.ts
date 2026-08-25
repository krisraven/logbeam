import * as fs from 'fs';
import * as readline from 'readline';
import { detectFormat, parseLine } from '../core/parser.js';
import type { LogEntry } from '../core/parser.js';

const SAMPLE_SIZE = 10;

type OnNewEntries = (entries: LogEntry[]) => void;

export function streamStdin(onNewEntries: OnNewEntries): () => void {
  const lineBuffer: string[] = [];
  let format: ReturnType<typeof detectFormat> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  const flushBuffer = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (format === null && lineBuffer.length > 0) {
      format = detectFormat(lineBuffer);
      const entries = lineBuffer
        .map(l => parseLine(l, format!))
        .filter((e): e is LogEntry => e !== null);
      lineBuffer.length = 0;
      if (entries.length > 0) onNewEntries(entries);
    }
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    lineBuffer.push(line);

    if (format === null) {
      if (lineBuffer.length >= SAMPLE_SIZE) {
        flushBuffer();
      } else {
        // Fewer than SAMPLE_SIZE lines — flush after 1s of inactivity so live
        // streams with sparse events don't stall waiting for the sample window.
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flushBuffer, 1000);
      }
    } else {
      const entry = parseLine(line, format);
      if (entry) onNewEntries([entry]);
    }
  });

  rl.on('close', () => {
    flushBuffer();
  });

  return () => { if (flushTimer) clearTimeout(flushTimer); rl.close(); };
}

export function tailFile(
  filePath: string,
  startPosition: number,
  format: ReturnType<typeof detectFormat>,
  onNewEntries: OnNewEntries
): () => void {
  let position = startPosition;
  let active = true;

  const check = () => {
    if (!active) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= position) return;

      const chunks: string[] = [];
      const readStream = fs.createReadStream(filePath, { start: position, end: stat.size - 1, encoding: 'utf8' });

      readStream.on('data', chunk => chunks.push(chunk as string));
      readStream.on('end', () => {
        position = stat.size;
        const entries = chunks.join('').split('\n')
          .filter(l => l.trim())
          .map(l => parseLine(l, format))
          .filter((e): e is LogEntry => e !== null);
        if (entries.length > 0) onNewEntries(entries);
      });
    } catch {
      // file rotated or deleted — stop tailing
      active = false;
    }
  };

  const watcher = fs.watch(filePath, check);
  return () => { active = false; watcher.close(); };
}
