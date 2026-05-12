# logbeam

A CLI tool that takes raw log output and transforms it into readable, colourised output — with an interactive fuzzy-search TUI for filtering and exploring logs in real time.

## Features

- **Auto-detects log format** — JSON, logfmt, or plain text, per file
- **Colourised output** by log level (error, warn, info, debug, trace)
- **Interactive TUI** with a scrollable log list and detail panel
- **Fuzzy search** powered by uFuzzy — filters as you type across timestamp, level, message, and all metadata fields
- **Pipe mode** — pretty-print logs directly to stdout when piped to another command
- Supports reading from a **file** or **stdin**

## Installation

```bash
npx logbeam
```

Or install globally:

```bash
npm install -g logbeam
```

## Usage

```bash
# Read from a file
logbeam app.log

# Pipe from stdin
cat app.log | logbeam

# Pipe from a running process
docker logs -f my-container | logbeam
tail -f /var/log/app.log | logbeam

# Pre-filter before the TUI opens
logbeam app.log --level warn
logbeam app.log --since 10m
logbeam app.log --level error --since 1h
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--level <level>` | Minimum log level to show: `trace`, `debug`, `info`, `warn`, `error` |
| `--since <duration>` | Only show logs from the last N seconds/minutes/hours/days e.g. `30s`, `10m`, `2h`, `1d` |

## TUI Controls

| Key | Action |
|-----|--------|
| Type | Filter logs (search is focused by default) |
| `Enter` / `Esc` | Switch to navigation mode |
| `/` | Focus search bar |
| `↑` / `↓` | Move selection up/down |
| `Page Up` / `Page Down` | Jump a full page |
| `e` | Toggle errors-only filter |
| `w` | Toggle warn+ filter (warn and above) |
| `c` | Copy selected entry's raw line to clipboard |
| `x` | Export current filtered results to a timestamped `.log` file |
| `f` | Resume following live output (re-enable auto-scroll) |
| `q` | Quit |
| `Ctrl+C` | Force quit |

## Log Formats

logbeam auto-detects the format by sampling the first 10 lines and picking the best match with a confidence threshold. Supported formats:

**JSON**
```json
{"timestamp":"2026-05-11T06:00:00Z","level":"error","message":"Request failed","traceId":"abc-123","statusCode":500}
```

**logfmt**
```
time=2026-05-11T06:00:00Z level=error msg="Request failed" traceId=abc-123 statusCode=500
```

**Plain text**
```
2026-05-11 06:00:00 ERROR Request failed
```

## Output

In pipe mode, each log entry is rendered on a single line with colourised level labels and dimmed metadata:

```
2026-05-11 06:00:00Z [ERR] Request failed  traceId=abc-123  statusCode=500
2026-05-11 06:00:01Z [WRN] High memory usage  usage=87%
2026-05-11 06:00:02Z [INF] Server started  port=3000
```

Level colours:

| Level | Colour |
|-------|--------|
| error / fatal | Red |
| warn | Yellow |
| info | Cyan |
| debug | Gray |
| trace | Magenta |

## Tech Stack

- [ink](https://github.com/vadimdemedes/ink) — React-based terminal UI
- [uFuzzy](https://github.com/leeoniya/uFuzzy) — high-performance fuzzy search
- [commander](https://github.com/tj/commander.js) — CLI argument parsing
- [chalk](https://github.com/chalk/chalk) — terminal colours (pipe mode)

## Roadmap

- [ ] Absolute timestamp support for `--since` (e.g. `--since 2026-05-11T06:00:00Z`)
- [ ] Highlight matched search terms in the log list
- [ ] Custom colour themes
