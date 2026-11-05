# pi-web-tokenline

[![npm version](https://img.shields.io/npm/v/pi-web-tokenline.svg)](https://www.npmjs.com/package/pi-web-tokenline)
[![license](https://img.shields.io/npm/l/pi-web-tokenline.svg)](LICENSE)

A minimal, live token telemetry footer for **[@jmfederico/pi-web](https://github.com/jmfederico/pi-web)**. Replaces the native `In / Out / Context / Cost` footer with real-time TPS and token accounting.

> Community plugin, not affiliated with the Pi Web maintainers. The footer styling and session endpoints are internal Pi Web implementation details and may change between Pi Web releases.

```text
TPS 42.5 tok/s  ·  Ctx 68.5K/272K  ·  In 2.4K  ·  Out 17.2K  ·  Cache R 140K  ·  W 2.3K
```

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

| Display     | Meaning                                                                            | Source                                                           |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **TPS**     | Approximate generated tokens per second, measured over a 2.5-second sliding window | Live assistant text + thinking deltas                            |
| **Ctx**     | Best available current context occupancy / model context window                    | Pi Web's compaction-aware session status; recent completed usage |
| **In**      | Cumulative uncached input tokens for the session                                   | Pi SDK session stats                                             |
| **Out**     | Cumulative output tokens; estimated pending output while streaming                 | Pi SDK session stats + live delta estimate                       |
| **Cache R** | Cumulative cache-read tokens                                                       | Pi SDK session stats                                             |
| **W**       | Cumulative cache-write tokens                                                      | Pi SDK session stats                                             |

**TPS is an estimate, not provider-reported throughput.** Provider chunking, thinking blocks, CJK text, and buffering affect it. Pi Web's browser event stream does not expose token-by-token tool-call argument generation, so TPS may read `0` during those periods. During a model stall, TPS decays to zero; while idle, it shows `--`.

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
