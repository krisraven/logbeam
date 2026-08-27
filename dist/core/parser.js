const LEVEL_ALIASES = {
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
function normaliseLevel(raw) {
    if (typeof raw !== "string")
        return "unknown";
    return LEVEL_ALIASES[raw.toLowerCase()] ?? "unknown";
}
function parseTimestamp(raw) {
    if (!raw)
        return null;
    const d = new Date(raw);
    if (isNaN(d.getTime()))
        return String(raw);
    return d
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "Z");
}
// `aws logs tail` (without --format json/short) prefixes every line with its
// own timestamp and the source log stream name, e.g.:
//   2026-08-27T04:50:54.215000+00:00 app-1787806253936 {"level":"info",...}
// The microsecond precision + explicit numeric UTC offset (rather than "Z")
// is a signature of Python's datetime.isoformat(), which is specific enough
// to this tool's output that it's safe to strip without misfiring on
// ordinary application log lines (which almost always use "Z" or
// millisecond precision instead).
const AWS_LOGS_TAIL_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}\s+\S+\s+([\s\S]*)$/;
function stripAwsLogsTailPrefix(line) {
    const match = line.match(AWS_LOGS_TAIL_PREFIX);
    return match ? match[1] : line;
}
function scoreJson(lines) {
    const hits = lines.filter((l) => {
        try {
            const v = JSON.parse(l);
            return typeof v === "object" && v !== null;
        }
        catch {
            return false;
        }
    });
    return hits.length / lines.length;
}
function scoreLogfmt(lines) {
    const hits = lines.filter((l) => /\w+=\S+/.test(l) && !l.trimStart().startsWith("{"));
    return hits.length / lines.length;
}
export function detectFormat(sample) {
    const nonEmpty = sample
        .map(stripAwsLogsTailPrefix)
        .filter((l) => l.trim().length > 0);
    if (nonEmpty.length === 0)
        return "text";
    const jsonScore = scoreJson(nonEmpty);
    const logfmtScore = scoreLogfmt(nonEmpty);
    if (jsonScore >= 0.6)
        return "json";
    if (logfmtScore >= 0.6)
        return "logfmt";
    return "text";
}
function parseJsonLine(line) {
    const obj = JSON.parse(line);
    const level = normaliseLevel(obj.level ?? obj.severity ?? obj.lvl);
    const message = String(obj.message ?? obj.msg ?? obj.text ?? "");
    const timestamp = parseTimestamp(obj.timestamp ?? obj.time ?? obj.ts ?? obj.t);
    const meta = {};
    for (const [k, v] of Object.entries(obj)) {
        if (![
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
        ].includes(k)) {
            meta[k] = v;
        }
    }
    return { timestamp, level, message, meta, raw: line };
}
function parseLogfmtLine(line) {
    const meta = {};
    const re = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
    let match;
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
const LEVEL_PATTERN = /\b(error|err|fatal|crit|warn|warning|info|debug|dbg|verbose|trace)\b/i;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
function parsePlainLine(line) {
    let rest = line;
    const tsMatch = rest.match(TIMESTAMP_PATTERN);
    const timestamp = tsMatch ? parseTimestamp(tsMatch[0]) : null;
    if (tsMatch)
        rest = rest.replace(tsMatch[0], "").trim();
    const levelMatch = rest.match(LEVEL_PATTERN);
    const level = levelMatch ? normaliseLevel(levelMatch[1]) : "unknown";
    if (levelMatch)
        rest = rest.replace(levelMatch[0], "").trim();
    return { timestamp, level, message: rest || line, meta: {}, raw: line };
}
export function parseLine(line, format) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    const content = stripAwsLogsTailPrefix(trimmed);
    let entry;
    try {
        entry =
            format === "json"
                ? parseJsonLine(content)
                : format === "logfmt"
                    ? parseLogfmtLine(content)
                    : parsePlainLine(content);
    }
    catch {
        entry = parsePlainLine(content);
    }
    entry.raw = trimmed;
    return entry;
}
