import React, { useState, useEffect, useCallback, useRef, useMemo, } from "react";
import * as fs from "fs";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import uFuzzy from "@leeoniya/ufuzzy";
import { SEVERITY } from "../core/filters.js";
import { BUFFER_CAP } from "../constants.js";
const LEVEL_COLOURS = {
    error: "red",
    warn: "yellow",
    info: "cyan",
    debug: "gray",
    trace: "magenta",
    unknown: "white",
};
const LEVEL_LABELS = {
    error: "ERR",
    warn: "WRN",
    info: "INF",
    debug: "DBG",
    trace: "TRC",
    unknown: "---",
};
const VISIBLE_ROWS = 20;
const uf = new uFuzzy();
function buildHaystack(entries) {
    return entries.map((e) => {
        const meta = Object.entries(e.meta)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
        return `${e.timestamp ?? ""} ${e.level} ${e.message} ${meta}`.trim();
    });
}
function getFieldOffsets(e) {
    let pos = 0;
    if (e.timestamp)
        pos += e.timestamp.length + 1;
    pos += e.level.length + 1;
    return { msgStart: pos, metaStart: pos + e.message.length + 1 };
}
function toSegments(str, fieldStart, ranges) {
    if (!ranges || ranges.length === 0)
        return [{ text: str, highlight: false }];
    const segs = [];
    let pos = 0;
    for (let i = 0; i < ranges.length; i += 2) {
        const lo = Math.max(0, ranges[i] - fieldStart);
        const hi = Math.min(str.length, ranges[i + 1] - fieldStart + 1);
        if (hi <= 0 || lo >= str.length || lo >= hi)
            continue;
        if (lo > pos)
            segs.push({ text: str.slice(pos, lo), highlight: false });
        segs.push({ text: str.slice(lo, hi), highlight: true });
        pos = hi;
    }
    if (pos < str.length)
        segs.push({ text: str.slice(pos), highlight: false });
    return segs;
}
function LogLine({ entry, selected, ranges }) {
    const colour = LEVEL_COLOURS[entry.level];
    const label = LEVEL_LABELS[entry.level];
    const metaEntries = Object.entries(entry.meta);
    const { msgStart, metaStart } = getFieldOffsets(entry);
    const msgSegs = toSegments(entry.message, msgStart, ranges ?? null);
    const metaStr = metaEntries.map(([k, v]) => `${k}=${v}`).join(" ");
    const metaSegs = toSegments(metaStr, metaStart, ranges ?? null);
    return (React.createElement(Box, { flexDirection: "row", backgroundColor: selected ? "blue" : undefined },
        React.createElement(Text, { dimColor: !selected }, entry.timestamp ? entry.timestamp + " " : ""),
        React.createElement(Text, { color: colour, bold: true },
            "[",
            label,
            "]"),
        React.createElement(Text, null, " "),
        React.createElement(Text, { color: entry.level === "error"
                ? "red"
                : entry.level === "warn"
                    ? "yellow"
                    : undefined }, msgSegs.map((seg, i) => (React.createElement(Text, { key: i, inverse: seg.highlight }, seg.text)))),
        metaEntries.length > 0 && (React.createElement(Text, { dimColor: true },
            "  ",
            metaSegs.map((seg, i) => (React.createElement(Text, { key: i, dimColor: !seg.highlight, inverse: seg.highlight }, seg.text)))))));
}
function DetailPanel({ entry }) {
    const metaEntries = Object.entries(entry.meta);
    const fixedKeys = entry.timestamp ? ['time', 'msg'] : ['msg'];
    const allKeys = [...fixedKeys, ...metaEntries.map(([k]) => k)];
    const keyWidth = Math.max(...allKeys.map(k => k.length));
    return (React.createElement(Box, { flexDirection: "column", borderStyle: "single", borderColor: "gray", paddingX: 1 },
        React.createElement(Text, { bold: true, color: LEVEL_COLOURS[entry.level] }, LEVEL_LABELS[entry.level]),
        entry.timestamp && (React.createElement(Box, { flexDirection: "row" },
            React.createElement(Box, { width: keyWidth, justifyContent: "flex-end" },
                React.createElement(Text, { dimColor: true }, "time")),
            React.createElement(Text, null,
                "  ",
                entry.timestamp))),
        React.createElement(Box, { flexDirection: "row" },
            React.createElement(Box, { width: keyWidth, justifyContent: "flex-end" },
                React.createElement(Text, { dimColor: true }, "msg")),
            React.createElement(Text, null,
                "  ",
                entry.message)),
        metaEntries.map(([k, v]) => (React.createElement(Box, { key: k, flexDirection: "row" },
            React.createElement(Box, { width: keyWidth, justifyContent: "flex-end" },
                React.createElement(Text, { dimColor: true }, k)),
            React.createElement(Text, null,
                "  ",
                String(v)))))));
}
export function App({ buffer, streaming = false }) {
    const { exit } = useApp();
    const [entries, setEntries] = useState(buffer.entries);
    const [following, setFollowing] = useState(streaming);
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const [offset, setOffset] = useState(0);
    const [searchFocused, setSearchFocused] = useState(true);
    const searchFocusedRef = useRef(true);
    const debounceTimer = useRef(null);
    const [levelFilter, setLevelFilter] = useState(null);
    const [statusMsg, setStatusMsg] = useState(null);
    const statusTimer = useRef(null);
    const setFocused = useCallback((val) => {
        searchFocusedRef.current = val;
        setSearchFocused(val);
    }, []);
    useEffect(() => {
        if (!streaming)
            return;
        const timer = setInterval(() => {
            const cap = buffer.entries.slice(-BUFFER_CAP);
            setEntries((prev) => (prev.length === cap.length ? prev : cap));
        }, 100);
        return () => clearInterval(timer);
    }, [buffer, streaming]);
    const showStatus = useCallback((msg) => {
        if (statusTimer.current)
            clearTimeout(statusTimer.current);
        setStatusMsg(msg);
        statusTimer.current = setTimeout(() => setStatusMsg(null), 2000);
    }, []);
    const levelFiltered = useMemo(() => {
        if (!levelFilter)
            return entries;
        const minSev = SEVERITY[levelFilter];
        return entries.filter((e) => SEVERITY[e.level] >= minSev);
    }, [entries, levelFilter]);
    const haystack = useMemo(() => buildHaystack(levelFiltered), [levelFiltered]);
    const filteredResult = useMemo(() => {
        if (!debouncedQuery.trim())
            return { entries: levelFiltered, ranges: [] };
        const [idxs, info] = uf.search(haystack, debouncedQuery);
        if (!idxs || idxs.length === 0)
            return { entries: [], ranges: [] };
        return {
            entries: idxs.map(i => levelFiltered[i]),
            ranges: idxs.map((_, j) => info?.ranges?.[j] ?? null),
        };
    }, [debouncedQuery, levelFiltered, haystack]);
    const filtered = filteredResult.entries;
    const filteredRanges = filteredResult.ranges;
    useEffect(() => {
        if (!following || !streaming)
            return;
        setSelected(filtered.length - 1);
        setOffset(Math.max(0, filtered.length - VISIBLE_ROWS));
    }, [filtered.length, following, streaming]);
    useEffect(() => {
        if (debounceTimer.current)
            clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => setDebouncedQuery(query), 150);
        return () => {
            if (debounceTimer.current)
                clearTimeout(debounceTimer.current);
        };
    }, [query]);
    useEffect(() => {
        setSelected(0);
        setOffset(0);
    }, [debouncedQuery]);
    const clamp = useCallback((n) => Math.max(0, Math.min(n, filtered.length - 1)), [filtered.length]);
    const currentEntry = filtered[selected];
    const currentEntryRef = useRef(currentEntry);
    currentEntryRef.current = currentEntry;
    const filteredRef = useRef(filtered);
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
            }
            catch {
                showStatus("Export failed");
            }
            return;
        }
        if (!focused) {
            if (key.upArrow) {
                setFollowing(false);
                setSelected((prev) => {
                    const next = clamp(prev - 1);
                    if (next < offset)
                        setOffset(next);
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
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, { borderStyle: "single", borderColor: "gray", paddingX: 1 },
            React.createElement(Text, { bold: true, color: "green" },
                "logbeam",
                " "),
            React.createElement(Text, { color: "cyan" }, "/"),
            React.createElement(Text, { dimColor: true }, " search "),
            React.createElement(Text, { color: "cyan" }, "esc"),
            React.createElement(Text, { dimColor: true }, " navigate "),
            React.createElement(Text, { color: "cyan" }, "e"),
            React.createElement(Text, { dimColor: true }, " errors "),
            React.createElement(Text, { color: "cyan" }, "w"),
            React.createElement(Text, { dimColor: true }, " warns "),
            React.createElement(Text, { color: "cyan" }, "c"),
            React.createElement(Text, { dimColor: true }, " copy "),
            React.createElement(Text, { color: "cyan" }, "x"),
            React.createElement(Text, { dimColor: true }, " export "),
            React.createElement(Text, { color: "cyan" }, "q"),
            React.createElement(Text, { dimColor: true }, " quit "),
            levelFilter && (React.createElement(Text, { color: "magenta", bold: true },
                "[",
                levelFilter === "error" ? "ERR" : "WRN+",
                "]",
                "  ")),
            streaming && (React.createElement(Text, { color: following ? "green" : "yellow" }, following ? "● live  " : "⏸ paused (f follow)  ")),
            statusMsg ? (React.createElement(Text, { color: "green" },
                statusMsg,
                " ")) : (React.createElement(Text, { dimColor: true },
                filtered.length,
                "/",
                entries.length,
                " entries"))),
        React.createElement(Box, { borderStyle: "single", borderColor: searchFocused ? "green" : "gray", paddingX: 1 },
            React.createElement(Text, { color: "green" }, "> "),
            React.createElement(TextInput, { value: query, onChange: setQuery, focus: searchFocused, placeholder: "Search..." })),
        React.createElement(Box, { flexDirection: "column" },
            visible.length === 0 && query.trim() !== "" && (React.createElement(Text, { dimColor: true },
                " no matches for \"",
                query,
                "\"")),
            visible.map((entry, i) => (React.createElement(LogLine, { key: `row-${offset + i}`, entry: entry, selected: offset + i === selected, ranges: visibleRanges[i] })))),
        currentEntry && React.createElement(DetailPanel, { entry: currentEntry })));
}
