import * as fs from 'fs';
import * as readline from 'readline';
import { detectFormat, parseLine } from './parser.js';
const SAMPLE_SIZE = 10;
export function streamStdin(onNewEntries) {
    const lineBuffer = [];
    let format = null;
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
        if (!line.trim())
            return;
        lineBuffer.push(line);
        if (format === null) {
            if (lineBuffer.length >= SAMPLE_SIZE) {
                format = detectFormat(lineBuffer.slice(0, SAMPLE_SIZE));
                const entries = lineBuffer
                    .map(l => parseLine(l, format))
                    .filter((e) => e !== null);
                lineBuffer.length = 0;
                if (entries.length > 0)
                    onNewEntries(entries);
            }
        }
        else {
            const entry = parseLine(line, format);
            if (entry)
                onNewEntries([entry]);
        }
    });
    return () => rl.close();
}
export function tailFile(filePath, startPosition, format, onNewEntries) {
    let position = startPosition;
    let active = true;
    const check = () => {
        if (!active)
            return;
        try {
            const stat = fs.statSync(filePath);
            if (stat.size <= position)
                return;
            const chunks = [];
            const readStream = fs.createReadStream(filePath, { start: position, end: stat.size - 1, encoding: 'utf8' });
            readStream.on('data', chunk => chunks.push(chunk));
            readStream.on('end', () => {
                position = stat.size;
                const entries = chunks.join('').split('\n')
                    .filter(l => l.trim())
                    .map(l => parseLine(l, format))
                    .filter((e) => e !== null);
                if (entries.length > 0)
                    onNewEntries(entries);
            });
        }
        catch {
            // file rotated or deleted — stop tailing
            active = false;
        }
    };
    const watcher = fs.watch(filePath, check);
    return () => { active = false; watcher.close(); };
}
