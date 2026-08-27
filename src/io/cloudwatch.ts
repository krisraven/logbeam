import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { detectFormat, parseLine } from '../core/parser.js';
import type { LogEntry } from '../core/parser.js';

const SAMPLE_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 2000;
// Force format detection from whatever's been collected after this many polls,
// so a log group that never produces SAMPLE_SIZE lines in one go doesn't stall
// forever waiting to fill the sample (same failure mode fixed for stdin in 0.1.3).
const MAX_POLLS_BEFORE_FORCED_DETECT = 3;

export interface CloudWatchTailOptions {
    region?: string;
    streamNamePrefix?: string;
    startTime?: number;
    pollIntervalMs?: number;
}

type OnNewEntries = (entries: LogEntry[]) => void;
type OnError = (err: Error) => void;

export function tailCloudWatchLogGroup(
    logGroupName: string,
    opts: CloudWatchTailOptions,
    onNewEntries: OnNewEntries,
    onError?: OnError,
): () => void {
    const client = new CloudWatchLogsClient(
        opts.region ? { region: opts.region } : {},
    );

    let startTime = opts.startTime ?? Date.now();
    let boundaryTimestamp = startTime;
    let boundaryIds = new Set<string>();

    let format: ReturnType<typeof detectFormat> | null = null;
    let sampleBuffer: string[] = [];
    let pollCount = 0;

    let active = true;
    let polling = false;

    const emit = (rawLines: string[]) => {
        if (rawLines.length === 0) return;

        if (format === null) {
            sampleBuffer.push(...rawLines);
            if (
                sampleBuffer.length < SAMPLE_SIZE &&
                pollCount < MAX_POLLS_BEFORE_FORCED_DETECT
            ) {
                return;
            }
            format = detectFormat(sampleBuffer.slice(0, SAMPLE_SIZE));
            const entries = sampleBuffer
                .map((l) => parseLine(l, format!))
                .filter((e): e is LogEntry => e !== null);
            sampleBuffer = [];
            if (entries.length > 0) onNewEntries(entries);
            return;
        }

        const entries = rawLines
            .map((l) => parseLine(l, format!))
            .filter((e): e is LogEntry => e !== null);
        if (entries.length > 0) onNewEntries(entries);
    };

    const poll = async () => {
        if (!active || polling) return;
        polling = true;
        pollCount++;
        try {
            const lines: string[] = [];
            let newBoundaryTimestamp = boundaryTimestamp;
            let newBoundaryIds = new Set<string>();
            let nextToken: string | undefined;

            do {
                const res = await client.send(
                    new FilterLogEventsCommand({
                        logGroupName,
                        logStreamNamePrefix: opts.streamNamePrefix,
                        startTime,
                        nextToken,
                        interleaved: true,
                    }),
                );

                for (const event of res.events ?? []) {
                    const ts = event.timestamp;
                    const id = event.eventId;

                    // CloudWatch's startTime filter is millisecond-granular and
                    // inclusive, so re-querying from the last seen timestamp can
                    // return the same events again — skip anything already seen
                    // at that exact boundary millisecond. Boundary tracking below
                    // still has to run for duplicates too, otherwise the next
                    // poll forgets this id was already seen.
                    const isDuplicate =
                        ts === boundaryTimestamp && id !== undefined && boundaryIds.has(id);

                    if (!isDuplicate && event.message) lines.push(event.message);

                    if (ts !== undefined) {
                        if (ts > newBoundaryTimestamp) {
                            newBoundaryTimestamp = ts;
                            newBoundaryIds = new Set(id ? [id] : []);
                        } else if (ts === newBoundaryTimestamp && id) {
                            newBoundaryIds.add(id);
                        }
                    }
                }

                nextToken = res.nextToken;
            } while (nextToken && active);

            startTime = newBoundaryTimestamp;
            boundaryTimestamp = newBoundaryTimestamp;
            boundaryIds = newBoundaryIds;

            emit(lines);
        } catch (err) {
            onError?.(err as Error);
        } finally {
            polling = false;
        }
    };

    const timer = setInterval(poll, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    void poll();

    return () => {
        active = false;
        clearInterval(timer);
    };
}
