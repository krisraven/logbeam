import React, {
    useState,
    useEffect,
    useCallback,
    useRef,
    useMemo,
} from "react";
import * as fs from "fs";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import uFuzzy from "@leeoniya/ufuzzy";
import type { LogEntry, LogLevel } from "../core/parser.js";
import { SEVERITY } from "../core/filters.js";
import { BUFFER_CAP } from "../constants.js";

const LEVEL_COLOURS: Record<LogLevel, string> = {
    error: "red",
    warn: "yellow",
    info: "cyan",
    debug: "gray",
    trace: "magenta",
    unknown: "white",
};

const LEVEL_LABELS: Record<LogLevel, string> = {
    error: "ERR",
    warn: "WRN",
    info: "INF",
    debug: "DBG",
    trace: "TRC",
    unknown: "---",
};

const VISIBLE_ROWS = 20;
const uf = new uFuzzy();

function buildHaystack(entries: LogEntry[]): string[] {
    return entries.map((e) => {
        const meta = Object.entries(e.meta)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
        return `${e.timestamp ?? ""} ${e.level} ${e.message} ${meta}`.trim();
    });
}

type Segment = { text: string; highlight: boolean };

function getFieldOffsets(e: LogEntry): { msgStart: number; metaStart: number } {
    let pos = 0;
    if (e.timestamp) pos += e.timestamp.length + 1;
    pos += e.level.length + 1;
    return { msgStart: pos, metaStart: pos + e.message.length + 1 };
}

function toSegments(str: string, fieldStart: number, ranges: number[] | null): Segment[] {
    if (!ranges || ranges.length === 0) return [{ text: str, highlight: false }];
    const segs: Segment[] = [];
    let pos = 0;
    for (let i = 0; i < ranges.length; i += 2) {
        const lo = Math.max(0, ranges[i] - fieldStart);
        const hi = Math.min(str.length, ranges[i + 1] - fieldStart + 1);
        if (hi <= 0 || lo >= str.length || lo >= hi) continue;
        if (lo > pos) segs.push({ text: str.slice(pos, lo), highlight: false });
        segs.push({ text: str.slice(lo, hi), highlight: true });
        pos = hi;
    }
    if (pos < str.length) segs.push({ text: str.slice(pos), highlight: false });
    return segs;
}

export interface LiveBuffer {
    entries: LogEntry[];
}

interface Props {
    buffer: LiveBuffer;
    streaming?: boolean;
}

function LogLine({ entry, selected, ranges }: { entry: LogEntry; selected: boolean; ranges?: number[] | null }) {
    const colour = LEVEL_COLOURS[entry.level];
    const label = LEVEL_LABELS[entry.level];
    const metaEntries = Object.entries(entry.meta);
    const { msgStart, metaStart } = getFieldOffsets(entry);
    const msgSegs = toSegments(entry.message, msgStart, ranges ?? null);
    const metaStr = metaEntries.map(([k, v]) => `${k}=${v}`).join(" ");
    const metaSegs = toSegments(metaStr, metaStart, ranges ?? null);

    return (
        <Box
            flexDirection="row"
            backgroundColor={selected ? "blue" : undefined}
        >
            <Text dimColor={!selected}>
                {entry.timestamp ? entry.timestamp + " " : ""}
            </Text>
            <Text color={colour} bold>
                [{label}]
            </Text>
            <Text> </Text>
            <Text
                color={
                    entry.level === "error"
                        ? "red"
                        : entry.level === "warn"
                          ? "yellow"
                          : undefined
                }
            >
                {msgSegs.map((seg, i) => (
                    <Text key={i} inverse={seg.highlight}>{seg.text}</Text>
                ))}
            </Text>
            {metaEntries.length > 0 && (
                <Text dimColor>
                    {"  "}
                    {metaSegs.map((seg, i) => (
                        <Text key={i} dimColor={!seg.highlight} inverse={seg.highlight}>{seg.text}</Text>
                    ))}
                </Text>
            )}
        </Box>
    );
}

function DetailPanel({ entry }: { entry: LogEntry }) {
    const metaEntries = Object.entries(entry.meta);
    const fixedKeys = entry.timestamp ? ['time', 'msg'] : ['msg'];
    const allKeys = [...fixedKeys, ...metaEntries.map(([k]) => k)];
    const keyWidth = Math.max(...allKeys.map(k => k.length));

    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
        >
            <Text bold color={LEVEL_COLOURS[entry.level]}>
                {LEVEL_LABELS[entry.level]}
            </Text>
            {entry.timestamp && (
                <Box flexDirection="row">
                    <Box width={keyWidth} justifyContent="flex-end">
                        <Text dimColor>time</Text>
                    </Box>
                    <Text>{"  "}{entry.timestamp}</Text>
                </Box>
            )}
            <Box flexDirection="row">
                <Box width={keyWidth} justifyContent="flex-end">
                    <Text dimColor>msg</Text>
                </Box>
                <Text>{"  "}{entry.message}</Text>
            </Box>
            {metaEntries.map(([k, v]) => (
                <Box key={k} flexDirection="row">
                    <Box width={keyWidth} justifyContent="flex-end">
                        <Text dimColor>{k}</Text>
                    </Box>
                    <Text>{"  "}{String(v)}</Text>
                </Box>
            ))}
        </Box>
    );
}

export function App({ buffer, streaming = false }: Props) {
    const { exit } = useApp();
    const [entries, setEntries] = useState<LogEntry[]>(buffer.entries);
    const [following, setFollowing] = useState(streaming);
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const [offset, setOffset] = useState(0);
    const [searchFocused, setSearchFocused] = useState(true);
    const searchFocusedRef = useRef(true);
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [levelFilter, setLevelFilter] = useState<"error" | "warn" | null>(
        null,
    );
    const [statusMsg, setStatusMsg] = useState<string | null>(null);
    const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const setFocused = useCallback((val: boolean) => {
        searchFocusedRef.current = val;
        setSearchFocused(val);
    }, []);

    useEffect(() => {
        if (!streaming) return;
        const timer = setInterval(() => {
            const cap = buffer.entries.slice(-BUFFER_CAP);
            setEntries((prev) => (prev.length === cap.length ? prev : cap));
        }, 100);
        return () => clearInterval(timer);
    }, [buffer, streaming]);

    useEffect(() => {
        if (!following || !streaming) return;
        setSelected(entries.length - 1);
        setOffset(Math.max(0, entries.length - VISIBLE_ROWS));
    }, [entries.length, following, streaming]);

    const showStatus = useCallback((msg: string) => {
        if (statusTimer.current) clearTimeout(statusTimer.current);
        setStatusMsg(msg);
        statusTimer.current = setTimeout(() => setStatusMsg(null), 2000);
    }, []);

    const levelFiltered: LogEntry[] = useMemo(() => {
        if (!levelFilter) return entries;
        const minSev = SEVERITY[levelFilter];
        return entries.filter((e) => SEVERITY[e.level] >= minSev);
    }, [entries, levelFilter]);

    const haystack = useMemo(
        () => buildHaystack(levelFiltered),
        [levelFiltered],
    );

    const filteredResult = useMemo(() => {
        if (!debouncedQuery.trim()) return { entries: levelFiltered, ranges: [] as (number[] | null)[] };
        const [idxs, info] = uf.search(haystack, debouncedQuery);
        if (!idxs || idxs.length === 0) return { entries: [] as LogEntry[], ranges: [] as (number[] | null)[] };
        return {
            entries: idxs.map(i => levelFiltered[i]),
            ranges: idxs.map((_, j) => info?.ranges?.[j] ?? null),
        };
    }, [debouncedQuery, levelFiltered, haystack]);
    const filtered = filteredResult.entries;
    const filteredRanges = filteredResult.ranges;

    useEffect(() => {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => setDebouncedQuery(query), 150);
        return () => {
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    }, [query]);

    useEffect(() => {
        setSelected(0);
        setOffset(0);
    }, [debouncedQuery]);

    const clamp = useCallback(
        (n: number) => Math.max(0, Math.min(n, filtered.length - 1)),
        [filtered.length],
    );

    const currentEntry = filtered[selected];
    const currentEntryRef = useRef<LogEntry | undefined>(currentEntry);
    currentEntryRef.current = currentEntry;

    const filteredRef = useRef<LogEntry[]>(filtered);
    filteredRef.current = filtered;

    useInput((input, key) => {
        const focused = searchFocusedRef.current;

        if (key.ctrl && input === "c") {
            exit();
            process.exit(0);
        }

        if (key.escape) {
            setFocused(false);
            return;
        }
        if (input === "/" && !focused) {
            setFocused(true);
            return;
        }
        if (input === "q" && !focused) {
            exit();
            process.exit(0);
        }

        if (input === "f" && !focused) {
            setFollowing(true);
            return;
        }

        if (input === "e" && !focused) {
            setLevelFilter((prev) => (prev === "error" ? null : "error"));
            setSelected(0);
            setOffset(0);
            return;
        }

        if (input === "w" && !focused) {
            setLevelFilter((prev) => (prev === "warn" ? null : "warn"));
            setSelected(0);
            setOffset(0);
            return;
        }

        if (input === "c" && !focused) {
            const entry = currentEntryRef.current;
            if (entry) {
                import("clipboardy")
                    .then(({ default: clipboard }) => {
                        clipboard.writeSync(entry.raw);
                        showStatus("Copied to clipboard");
                    })
                    .catch(() => showStatus("Copy failed"));
            }
            return;
        }

        if (input === "x" && !focused) {
            const snapshot = filteredRef.current;
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const outPath = `./logbeam-export-${timestamp}.log`;
            const lines = snapshot.map((e) => e.raw).join("\n") + "\n";
            try {
                fs.writeFileSync(outPath, lines, "utf8");
                showStatus(`Exported ${snapshot.length} entries → ${outPath}`);
            } catch {
                showStatus("Export failed");
            }
            return;
        }

        if (!focused) {
            if (key.upArrow) {
                setFollowing(false);
                setSelected((prev) => {
                    const next = clamp(prev - 1);
                    if (next < offset) setOffset(next);
                    return next;
                });
            }
            if (key.downArrow) {
                setFollowing(false);
                setSelected((prev) => {
                    const next = clamp(prev + 1);
                    if (next >= offset + VISIBLE_ROWS)
                        setOffset(next - VISIBLE_ROWS + 1);
                    return next;
                });
            }
            if (key.pageUp) {
                setFollowing(false);
                setSelected((prev) => {
                    const next = clamp(prev - VISIBLE_ROWS);
                    setOffset(next);
                    return next;
                });
            }
            if (key.pageDown) {
                setFollowing(false);
                setSelected((prev) => {
                    const next = clamp(prev + VISIBLE_ROWS);
                    setOffset(Math.max(0, next - VISIBLE_ROWS + 1));
                    return next;
                });
            }
        }

        if (focused && key.return) {
            setFocused(false);
        }
    });

    const visible = filtered.slice(offset, offset + VISIBLE_ROWS);
    const visibleRanges = filteredRanges.slice(offset, offset + VISIBLE_ROWS);

    return (
        <Box flexDirection="column">
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text bold color="green">
                    logbeam{" "}
                </Text>
                <Text color="cyan">/</Text>
                <Text dimColor> search </Text>
                <Text color="cyan">esc</Text>
                <Text dimColor> navigate </Text>
                <Text color="cyan">e</Text>
                <Text dimColor> errors </Text>
                <Text color="cyan">w</Text>
                <Text dimColor> warns </Text>
                <Text color="cyan">c</Text>
                <Text dimColor> copy </Text>
                <Text color="cyan">x</Text>
                <Text dimColor> export </Text>
                <Text color="cyan">q</Text>
                <Text dimColor> quit </Text>
                {levelFilter && (
                    <Text color="magenta" bold>
                        [{levelFilter === "error" ? "ERR" : "WRN+"}]{"  "}
                    </Text>
                )}
                {streaming && (
                    <Text color={following ? "green" : "yellow"}>
                        {following ? "● live  " : "⏸ paused (f follow)  "}
                    </Text>
                )}
                {statusMsg ? (
                    <Text color="green">{statusMsg} </Text>
                ) : (
                    <Text dimColor>
                        {filtered.length}/{entries.length} entries
                    </Text>
                )}
            </Box>

            <Box
                borderStyle="single"
                borderColor={searchFocused ? "green" : "gray"}
                paddingX={1}
            >
                <Text color="green">{"> "}</Text>
                <TextInput
                    value={query}
                    onChange={setQuery}
                    focus={searchFocused}
                    placeholder="Search..."
                />
            </Box>

            <Box flexDirection="column">
                {visible.length === 0 && query.trim() !== "" && (
                    <Text dimColor> no matches for "{query}"</Text>
                )}
                {visible.map((entry, i) => (
                    <LogLine
                        key={`row-${offset + i}`}
                        entry={entry}
                        selected={offset + i === selected}
                        ranges={visibleRanges[i]}
                    />
                ))}
            </Box>

            {currentEntry && <DetailPanel entry={currentEntry} />}
        </Box>
    );
}
