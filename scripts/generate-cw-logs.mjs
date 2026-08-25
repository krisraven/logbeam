#!/usr/bin/env node
/**
 * generate-cw-logs.mjs — synthetic log generator for logbeam testing
 *
 * Modes:
 *   --local    Write NDJSON to stdout (pipe directly to logbeam, no AWS needed)
 *   (default)  Push batches to AWS CloudWatch Logs
 *
 * Required IAM permissions for CloudWatch mode:
 *   {
 *     "Effect": "Allow",
 *     "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
 *     "Resource": "arn:aws:logs:*:*:log-group:/logbeam/*"
 *   }
 *
 * Usage:
 *   node scripts/generate-cw-logs.mjs --local --count 50 | logbeam
 *   node scripts/generate-cw-logs.mjs --group /logbeam/test --interval 1000
 *   aws logs tail /logbeam/test --follow | logbeam
 */

// ---------------------------------------------------------------------------
// Exit quietly if the reader on the other end of the pipe (e.g. logbeam) closes early
// ---------------------------------------------------------------------------

process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {
        local: false,
        group: "/logbeam/test",
        stream: `app-${Date.now()}`,
        interval: 500,
        count: 1,
        batchSize: 10,
        format: "json",
        region: process.env.AWS_REGION || "ap-southeast-2",
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--local") {
            args.local = true;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }

        const next = argv[i + 1];
        if (arg === "--group") {
            args.group = next;
            i++;
            continue;
        }
        if (arg === "--stream") {
            args.stream = next;
            i++;
            continue;
        }
        if (arg === "--interval") {
            args.interval = parseInt(next, 10);
            i++;
            continue;
        }
        if (arg === "--count") {
            args.count = parseInt(next, 10);
            i++;
            continue;
        }
        if (arg === "--batch-size") {
            args.batchSize = parseInt(next, 10);
            i++;
            continue;
        }
        if (arg === "--format") {
            args.format = next;
            i++;
            continue;
        }
        if (arg === "--region") {
            args.region = next;
            i++;
            continue;
        }

        // support --flag=value form
        const eq = arg.indexOf("=");
        if (eq !== -1) {
            const key = arg.slice(0, eq);
            const val = arg.slice(eq + 1);
            if (key === "--group") args.group = val;
            else if (key === "--stream") args.stream = val;
            else if (key === "--interval") args.interval = parseInt(val, 10);
            else if (key === "--count") args.count = parseInt(val, 10);
            else if (key === "--batch-size") args.batchSize = parseInt(val, 10);
            else if (key === "--format") args.format = val;
            else if (key === "--region") args.region = val;
        }
    }
    return args;
}

function printHelp() {
    console.error(`
generate-cw-logs.mjs — synthetic log generator for logbeam

Options:
  --local           Write NDJSON to stdout instead of CloudWatch
  --group <name>    CloudWatch log group  (default: /logbeam/test)
  --stream <name>   CloudWatch log stream (default: app-<timestamp>)
  --interval <ms>   Delay between batches (default: 500)
  --count <n>       Total events; 0 = infinite (default: 100)
  --batch-size <n>  Events per PutLogEvents call (default: 10)
  --format <f>      json | logfmt | plain (default: json)
  --region <r>      AWS region (default: us-east-1)

Examples:
  node scripts/generate-cw-logs.mjs --local --count 50 | logbeam
  node scripts/generate-cw-logs.mjs --local --format logfmt --count 0 | logbeam
  node scripts/generate-cw-logs.mjs --group /logbeam/test --interval 1000
`);
}

// ---------------------------------------------------------------------------
// Synthetic log data
// ---------------------------------------------------------------------------

const USERS = ["user-1042", "user-2891", "user-3847", "user-5519", "user-7723"];
const SERVICES = [
    "auth-service",
    "api-gateway",
    "data-processor",
    "notifier",
    "scheduler",
];
const ROUTES = [
    "/api/users",
    "/api/orders",
    "/api/products",
    "/api/auth/login",
    "/api/health",
];
const ERRORS = [
    "ECONNREFUSED: connection to db refused",
    "TimeoutError: query exceeded 5000ms",
    "ValidationError: email field is required",
    "RateLimitError: too many requests from this IP",
    "NotFoundError: resource does not exist",
];

function uid(len = 8) {
    return Math.random()
        .toString(36)
        .slice(2, 2 + len);
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function getLevel() {
    const r = Math.random();
    if (r < 0.6) return "info";
    if (r < 0.8) return "debug";
    if (r < 0.9) return "warn";
    if (r < 0.95) return "error";
    return "trace";
}

function generateEntry(ts) {
    const level = getLevel();
    const service = pick(SERVICES);
    const userId = pick(USERS);
    const reqId = `req-${uid()}`;
    const traceId = `trace-${uid(12)}`;
    const duration = Math.floor(Math.random() * 900) + 10;
    const route = pick(ROUTES);

    let message;
    if (level === "error") {
        message = pick(ERRORS);
    } else if (level === "warn") {
        message = `slow response on ${route} (${duration}ms)`;
    } else if (level === "debug") {
        message = `cache miss for key ${uid(6)}`;
    } else if (level === "trace") {
        message = `entering middleware chain for ${route}`;
    } else {
        const actions = [
            `GET ${route} 200`,
            `user ${userId} authenticated`,
            `job completed in ${duration}ms`,
            `POST ${route} 201`,
            `session refreshed for ${userId}`,
        ];
        message = pick(actions);
    }

    return {
        timestamp: new Date(ts).toISOString(),
        level,
        message,
        service,
        userId,
        requestId: reqId,
        traceId,
        duration,
    };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function toJson(entry) {
    return JSON.stringify(entry);
}

function toLogfmt(entry) {
    const pairs = Object.entries(entry).map(([k, v]) => {
        const s = String(v);
        return s.includes(" ") ? `${k}="${s}"` : `${k}=${s}`;
    });
    return pairs.join(" ");
}

function toPlain(entry) {
    const { timestamp, level, message, service, userId, duration } = entry;
    return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}  service=${service} userId=${userId} duration=${duration}ms`;
}

function formatEntry(entry, format) {
    if (format === "logfmt") return toLogfmt(entry);
    if (format === "plain") return toPlain(entry);
    return toJson(entry);
}

// ---------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------

async function runLocal(args) {
    const { count, interval, batchSize, format } = args;
    let emitted = 0;
    let ts = Date.now();
    let done = false;

    process.on("SIGINT", () => {
        done = true;
    });

    while (!done && (count === 0 || emitted < count)) {
        const batch = [];
        for (
            let i = 0;
            i < batchSize && (count === 0 || emitted + i < count);
            i++
        ) {
            batch.push(generateEntry(ts));
            ts += Math.floor(Math.random() * 200) + 50;
        }
        for (const entry of batch) {
            process.stdout.write(formatEntry(entry, format) + "\n");
        }
        emitted += batch.length;
        if (count === 0 || emitted < count) {
            await sleep(interval);
        }
    }
}

// ---------------------------------------------------------------------------
// CloudWatch mode
// ---------------------------------------------------------------------------

async function runCloudWatch(args) {
    const { group, stream, interval, count, batchSize, format, region } = args;

    let CloudWatchLogsClient,
        CreateLogGroupCommand,
        CreateLogStreamCommand,
        PutLogEventsCommand;
    try {
        ({
            CloudWatchLogsClient,
            CreateLogGroupCommand,
            CreateLogStreamCommand,
            PutLogEventsCommand,
        } = await import("@aws-sdk/client-cloudwatch-logs"));
    } catch (e) {
        console.error(`Error loading AWS SDK: ${e.message}`);
        console.error("Run: npm install");
        process.exit(1);
    }
    const client = new CloudWatchLogsClient({ region });

    // Create group/stream (idempotent)
    try {
        await client.send(new CreateLogGroupCommand({ logGroupName: group }));
    } catch (e) {
        if (e.name !== "ResourceAlreadyExistsException") throw e;
    }
    try {
        await client.send(
            new CreateLogStreamCommand({
                logGroupName: group,
                logStreamName: stream,
            }),
        );
    } catch (e) {
        if (e.name !== "ResourceAlreadyExistsException") throw e;
    }

    console.error(
        `Pushing to CloudWatch: ${group} / ${stream} (region: ${region})`,
    );
    console.error(
        `Tail with: aws logs tail ${group} --log-stream-names ${stream} --follow | logbeam`,
    );

    let emitted = 0;
    let ts = Date.now();
    let done = false;

    process.on("SIGINT", () => {
        done = true;
    });

    while (!done && (count === 0 || emitted < count)) {
        const batch = [];
        for (
            let i = 0;
            i < batchSize && (count === 0 || emitted + i < count);
            i++
        ) {
            const entry = generateEntry(ts);
            batch.push({ timestamp: ts, message: formatEntry(entry, format) });
            ts += Math.floor(Math.random() * 200) + 50;
        }

        try {
            await client.send(
                new PutLogEventsCommand({
                    logGroupName: group,
                    logStreamName: stream,
                    logEvents: batch,
                }),
            );
            emitted += batch.length;
            process.stderr.write(`\r${emitted} events pushed`);
        } catch (e) {
            console.error(`\nPutLogEvents failed: ${e.message}`);
            // brief pause before retry
            await sleep(2000);
            continue;
        }

        if (count === 0 || emitted < count) {
            await sleep(interval);
        }
    }

    console.error(`\nDone. ${emitted} events written to ${group}/${stream}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parseArgs(process.argv);

if (args.local) {
    await runLocal(args);
} else {
    await runCloudWatch(args);
}
