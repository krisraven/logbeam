export type LogLevel =
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "unknown";

export interface LogEntry {
    timestamp: string | null;
    level: LogLevel;
    message: string;
    meta: Record<string, unknown>;
    raw: string;
}

type Format = "json" | "logfmt" | "text";

const LEVEL_ALIASES: Record<string, LogLevel> = {
    error: "error",
    err: "error",
    fatal: "error",
    crit: "error",
    warn: "warn",
    warning: "warn",
    info: "info",
    information: "info",
    debug: "debug",
    dbg: "debug",
    verbose: "debug",
    trace: "trace",
};

function normaliseLevel(raw: unknown): LogLevel {
    if (typeof raw !== "string") return "unknown";
    return LEVEL_ALIASES[raw.toLowerCase()] ?? "unknown";
}

function parseTimestamp(raw: unknown): string | null {
    if (!raw) return null;
    const d = new Date(raw as string);
    if (isNaN(d.getTime())) return String(raw);
    return d
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "Z");
}

function scoreJson(lines: string[]): number {
    const hits = lines.filter((l) => {
        try {
            const v = JSON.parse(l);
            return typeof v === "object" && v !== null;
        } catch {
            return false;
        }
    });
    return hits.length / lines.length;
}

function scoreLogfmt(lines: string[]): number {
    const hits = lines.filter(
        (l) => /\w+=\S+/.test(l) && !l.trimStart().startsWith("{"),
    );
    return hits.length / lines.length;
}

export function detectFormat(sample: string[]): Format {
    const nonEmpty = sample.filter((l) => l.trim().length > 0);
    if (nonEmpty.length === 0) return "text";
    const jsonScore = scoreJson(nonEmpty);
    const logfmtScore = scoreLogfmt(nonEmpty);
    if (jsonScore >= 0.6) return "json";
    if (logfmtScore >= 0.6) return "logfmt";
    return "text";
}

function parseJsonLine(line: string): LogEntry {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const level = normaliseLevel(obj.level ?? obj.severity ?? obj.lvl);
    const message = String(obj.message ?? obj.msg ?? obj.text ?? "");
    const timestamp = parseTimestamp(
        obj.timestamp ?? obj.time ?? obj.ts ?? obj.t,
    );
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (
            ![
                "level",
                "severity",
                "lvl",
                "message",
                "msg",
                "text",
                "timestamp",
                "time",
                "ts",
                "t",
            ].includes(k)
        ) {
            meta[k] = v;
        }
    }
    return { timestamp, level, message, meta, raw: line };
}

function parseLogfmtLine(line: string): LogEntry {
    const meta: Record<string, unknown> = {};
    const re = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
        const key = match[1];
        const val = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2];
        meta[key] = val;
    }
    const level = normaliseLevel(meta.level ?? meta.lvl ?? meta.severity);
    const message = String(meta.message ?? meta.msg ?? "");
    const timestamp = parseTimestamp(meta.timestamp ?? meta.time ?? meta.ts);
    for (const k of [
        "level",
        "lvl",
        "severity",
        "message",
        "msg",
        "timestamp",
        "time",
        "ts",
    ]) {
        delete meta[k];
    }
    return { timestamp, level, message, meta, raw: line };
}

const LEVEL_PATTERN =
    /\b(error|err|fatal|crit|warn|warning|info|debug|dbg|verbose|trace)\b/i;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

function parsePlainLine(line: string): LogEntry {
    let rest = line;
    const tsMatch = rest.match(TIMESTAMP_PATTERN);
    const timestamp = tsMatch ? parseTimestamp(tsMatch[0]) : null;
    if (tsMatch) rest = rest.replace(tsMatch[0], "").trim();

    const levelMatch = rest.match(LEVEL_PATTERN);
    const level = levelMatch ? normaliseLevel(levelMatch[1]) : "unknown";
    if (levelMatch) rest = rest.replace(levelMatch[0], "").trim();

    return { timestamp, level, message: rest || line, meta: {}, raw: line };
}

export function parseLine(line: string, format: Format): LogEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
        if (format === "json") return parseJsonLine(trimmed);
        if (format === "logfmt") return parseLogfmtLine(trimmed);
        return parsePlainLine(trimmed);
    } catch {
        return parsePlainLine(trimmed);
    }
}
