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

## Piping from AWS CloudWatch

Use `aws logs tail` with logbeam to tail CloudWatch log groups:

```bash
PYTHONUNBUFFERED=1 aws logs tail /my/log-group --follow | logbeam
```

The `PYTHONUNBUFFERED=1` prefix is required when using `--follow`. Without it, the AWS CLI (a Python 3 program) switches to block-buffered output when writing to a pipe — it accumulates ~8 KB before flushing, so logbeam receives nothing until the buffer fills or the process exits. `PYTHONUNBUFFERED=1` forces Python to flush immediately after each write.

Note: `stdbuf -oL` is commonly suggested for this problem but **does not work with Python 3** — Python 3 uses its own I/O layer that bypasses C stdio, so `stdbuf`'s libc patch has no effect. Use `PYTHONUNBUFFERED=1` instead.

This only affects Python-based CLI tools. Other common sources (`tail -f`, `kubectl logs -f`, `docker logs -f`) are unaffected.

```bash
# Add to ~/.zshrc or ~/.bashrc for convenience
alias logbeam-tail='PYTHONUNBUFFERED=1 aws logs tail'

# Then:
logbeam-tail /my/log-group --follow | logbeam
```

## CLI Flags

| Flag                 | Description                                                                             |
| -------------------- | --------------------------------------------------------------------------------------- |
| `--level <level>`    | Minimum log level to show: `trace`, `debug`, `info`, `warn`, `error`                    |
| `--since <duration>` | Only show logs from the last N seconds/minutes/hours/days e.g. `30s`, `10m`, `2h`, `1d` |

**Known limitation:** `--level` and `--since` currently only apply in the interactive TUI. In pipe mode (output not a TTY, e.g. `logbeam app.log | grep foo`), both flags are ignored and every line is printed.

## TUI Controls

| Key                     | Action                                                       |
| ----------------------- | ------------------------------------------------------------ |
| Type                    | Filter logs (search is focused by default)                   |
| `Enter` / `Esc`         | Switch to navigation mode                                    |
| `/`                     | Focus search bar                                             |
| `↑` / `↓`               | Move selection up/down                                       |
| `Page Up` / `Page Down` | Jump a full page                                             |
| `e`                     | Toggle errors-only filter                                    |
| `w`                     | Toggle warn+ filter (warn and above)                         |
| `c`                     | Copy selected entry's raw line to clipboard                  |
| `x`                     | Export current filtered results to a timestamped `.log` file |
| `f`                     | Resume following live output (re-enable auto-scroll)         |
| `q`                     | Quit                                                         |
| `Ctrl+C`                | Force quit                                                   |

## Log Formats

logbeam auto-detects the format by sampling the first 10 lines and picking the best match with a confidence threshold. Supported formats:

**JSON**

```json
{
    "timestamp": "2026-05-11T06:00:00Z",
    "level": "error",
    "message": "Request failed",
    "traceId": "abc-123",
    "statusCode": 500
}
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

| Level         | Colour  |
| ------------- | ------- |
| error / fatal | Red     |
| warn          | Yellow  |
| info          | Cyan    |
| debug         | Gray    |
| trace         | Magenta |

## Tech Stack

- [ink](https://github.com/vadimdemedes/ink) — React-based terminal UI
- [uFuzzy](https://github.com/leeoniya/uFuzzy) — high-performance fuzzy search
- [commander](https://github.com/tj/commander.js) — CLI argument parsing
- [chalk](https://github.com/chalk/chalk) — terminal colours (pipe mode)

## Testing

There's no automated test suite yet. Canges are verified manually against a build (`npm run build`, then `npm start` / `node dist/index.js`):

**Static fixtures.** `test-json.log`, `test-logfmt.log`, and `test-plain.log` in the repo root each contain 100 sample lines in one of the three supported formats. Use them to sanity-check parsing and rendering:

```bash
# Pipe mode — check colourised output and field extraction
cat test-json.log | npm start
cat test-logfmt.log | npm start
cat test-plain.log | npm start

# TUI mode — check search, filters, and the detail panel (run in a real terminal, not piped)
node dist/index.js test-json.log
```

**Synthetic live streams.** `scripts/generate-cw-logs.mjs --local` generates fake log lines on the fly, useful for exercising streaming/tailing behaviour that the static fixtures can't (sparse output, live stdin, following mode):

```bash
node scripts/generate-cw-logs.mjs --local --count 0 --interval 500 | npm start
```

When testing changes, check pipe mode and TUI mode separately, and try all three log formats — format-detection bugs have historically only shown up in specific combinations (see Changelog).

## Roadmap

- [ ] Absolute timestamp support for `--since` (e.g. `--since 2026-05-11T06:00:00Z`)
- [ ] Highlight matched search terms in the log list
- [ ] Custom colour themes

## Changelog

### 0.1.3

**Fix: live piped stdin never rendered**
When logbeam received a live stream via stdin (e.g. `aws logs tail --follow | logbeam`), it called `loadEntries()` internally, which reads stdin until EOF before rendering. Live streams never send EOF, so the TUI never launched. Replaced with `streamStdin()`, which feeds entries into the TUI as they arrive without waiting for the stream to close.

**Fix: sparse streams stalled before showing any entries**
`streamStdin` buffered the first 10 lines before detecting log format. On a slow or sparse stream this meant logbeam would appear blank for a long time (or forever if fewer than 10 lines arrived while the stream stayed open). It now detects format after a 1-second pause with whatever lines it has, so the first entry appears within a second of arriving.

**Fix: small files piped to logbeam showed nothing**
When a file with fewer than 10 lines was piped in (`cat tiny.log | logbeam`), `streamStdin` never reached its sample threshold and silently dropped all buffered lines on stream close. Added a close-event handler that flushes and detects format from whatever has been buffered.
