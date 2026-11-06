# pi-web-tokenline

[![npm version](https://img.shields.io/npm/v/pi-web-tokenline.svg)](https://www.npmjs.com/package/pi-web-tokenline)
[![license](https://img.shields.io/npm/l/pi-web-tokenline.svg)](LICENSE)

A minimal, live token telemetry footer for **[@jmfederico/pi-web](https://github.com/jmfederico/pi-web)**. Replaces the native `In / Out / Context / Cost` footer with real-time TPS and token accounting.

> Community plugin, not affiliated with the Pi Web maintainers. The footer styling and session endpoints are internal Pi Web implementation details and may change between Pi Web releases.

```text
TPS 48 tok/s  ·  Ctx 68.5K/272K  ·  In 2.4K  ·  Out 17.2K  ·  Cache R 140K  ·  W 2.3K
```

`TPS ~67` is a live estimate; `TPS 48` is an exact decode final; `TPS 41 tok/s avg` is an exact end-to-end final for a message whose tool-call tokens could not be observed while streaming.

## Install

Install the published package:

```sh
pi install npm:pi-web-tokenline
```

To follow the repository instead of a release:

```sh
pi install git:github.com/EAimTY/pi-web-tokenline
```

1. Open **Pi Web → Settings → PI WEB plugins** and make sure **Tokenline** (plugin ID `tokenline`) is enabled.
2. Reload the Pi Web browser tab. This is a **browser-only** plugin; no session-daemon restart is needed for normal installation.
3. Select a running conversation. The original footer is replaced after session status becomes available.

If you installed the separate `pi-token-speed` Pi extension solely for this purpose, it is not required:

```sh
pi remove npm:pi-token-speed
```

You can also remove the now-unused `tokenSpeed` section from `~/.pi/agent/settings.json`. **Do not remove any of your other Pi packages.**

## Metrics

| Display     | Meaning                                                                 | Source                                                           |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **TPS**     | Live estimated decode TPS; exact per-message decode or end-to-end final | Live assistant text + thinking deltas; provider usage at the end |
| **Ctx**     | Best available current context occupancy / model context window         | Pi Web's compaction-aware session status; recent completed usage |
| **In**      | Cumulative uncached input tokens for the session                        | Pi SDK session stats                                             |
| **Out**     | Cumulative output tokens; estimated pending output while streaming      | Pi SDK session stats + live delta estimate                       |
| **Cache R** | Cumulative cache-read tokens                                            | Pi SDK session stats                                             |
| **W**       | Cumulative cache-write tokens                                           | Pi SDK session stats                                             |

**TPS has live and final states.** While text streams, `TPS ~67` is an estimate over a 3-second trailing window. The first chunk only opens the window because its generation time happened before the browser could observe it; later intervals are capped at twice the recent pace, and the first second has no published rate. This keeps buffered chunks from printing four-digit values. After three silent seconds the live value reads `0`; a stream that ends shows its final value.

When an assistant message ends, the footer replaces the live estimate with an exact per-message reading. A message with no tool call gets **exact decode TPS** (`output ÷ first token → end`). A message with tool calls, reasoning that never streamed, or a buffered response gets **exact end-to-end TPS** (`output ÷ assistant message start → end`) and is labeled `avg`. Pi Web's browser event stream does not expose tool-call argument deltas, so live TPS may read `0` while those arguments are generated; the `avg` value is the safe final reading.

**The estimate is calibrated per model.** After a fully observable message, the character estimate is adjusted toward the provider's output count within a conservative range. Tool-call messages, hidden reasoning, and end-to-end fallback messages never train the calibration, because their delta windows do not cover the same output the provider counted. `Out` still snaps to provider usage at the end of each message.

**Context is not cumulative session input.** It is the best available estimate of the context sent to the model. Immediately after compaction, Pi may legitimately report an unknown context length, displayed as `Ctx --/272K`, until a new response is available. Session token counters reflect Pi's own usage semantics, including any branching and cache accounting.

## Compatibility and privacy

- Intended for **`@jmfederico/pi-web`**. This is **not** a plugin for `@agegr/pi-web`.
- Requires a modern Pi Web build with browser plugin API v5, stylesheet contributions and selection subscriptions.
- The plugin subscribes only to the **currently selected session**, using same-origin Pi Web `status` and WebSocket `events` endpoints. No independent telemetry server, Magpie integration, external API, or credential access.
- The footer is replaced using a plugin-contributed stylesheet on Pi Web's `status-bar` Shadow DOM (`.bar`). This markup is **not a stable public plugin API**; a Pi Web update may break the replacement.
- On disable/unload or session status failure, the browser restores the native footer. Browser tab refresh/reconnect restores live subscriptions.

## Development

```sh
npm ci
npm run check        # Biome and tsc
npm test             # Vitest
npm run build        # regenerate dist/
npm run verify:dist  # fail when dist/ is stale
npm pack --dry-run
```

The package has no runtime dependencies. `src/` is TypeScript and is never served to the browser: PI WEB serves everything inside `browserRoot` (`dist/`) verbatim and does not compile installed plugin source, so the built module and stylesheet are committed and must be regenerated with `npm run build` alongside any source change.

`src/pi-web-plugin.ts` holds the browser lifecycle and session subscriptions, `src/metrics.ts` the formatting and TPS calculations, `src/host-contract.ts` the private session payloads the footer reads, and `src/footer.css` the footer replacement. Tests sit beside their modules as `*.test.ts`.

## License

[MIT](LICENSE) © 2026 EAimTY.
