import * as fs from 'fs';
import * as readline from 'readline';
import { detectFormat, parseLine } from './parser.js';
const SAMPLE_SIZE = 10;
async function streamToLines(filePath) {
    const stream = filePath ? fs.createReadStream(filePath) : process.stdin;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const lines = [];
    for await (const line of rl)
        lines.push(line);
    return lines;
}
export async function loadEntries(filePath) {
    const lines = await streamToLines(filePath);
    const sample = lines.slice(0, SAMPLE_SIZE).filter(l => l.trim().length > 0);
    const format = detectFormat(sample);
    return lines.map(l => parseLine(l, format)).filter((e) => e !== null);
}
export async function readLines(filePath) {
    const { renderEntry } = await import('./renderer.js');
    const stream = filePath
        ? fs.createReadStream(filePath)
        : process.stdin;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const buffer = [];
    let format = null;
    for await (const line of rl) {
        buffer.push(line);
        if (format === null && buffer.length >= SAMPLE_SIZE) {
            format = detectFormat(buffer.slice(0, SAMPLE_SIZE));
            for (const bufferedLine of buffer) {
                const entry = parseLine(bufferedLine, format);
                if (entry)
                    process.stdout.write(renderEntry(entry) + '\n');
            }
            buffer.length = 0;
            continue;
        }
        if (format !== null) {
            const entry = parseLine(line, format);
            if (entry)
                process.stdout.write(renderEntry(entry) + '\n');
        }
    }
    // flush remaining buffer if we never hit SAMPLE_SIZE
    if (format === null && buffer.length > 0) {
        format = detectFormat(buffer);
        for (const line of buffer) {
            const entry = parseLine(line, format);
            if (entry)
                process.stdout.write(renderEntry(entry) + '\n');
        }
    }
}
