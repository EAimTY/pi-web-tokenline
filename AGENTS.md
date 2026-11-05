This file applies to the entire repository.

This repository is the Tokenline PI WEB plugin: a browser-only footer that replaces PI WEB's native session status line with live TPS and token accounting. It has no server entry, no runtime dependency, and no build-time dependency on the host.

## Architecture

- **`src/` is the only source of truth; `dist/` is committed build output.** PI WEB serves everything inside `browserRoot` verbatim and never compiles installed plugin source, and `pi install git:…` clones the repository and runs `npm install --omit=dev`, which runs `prepare` without a dev toolchain. A source-only package would install broken, so the Vite library build in `dist/` is tracked and `npm run verify:dist` fails when it drifts from `src/`. Never edit `dist/` by hand.
- `src/pi-web-plugin.ts` — the browser entry: selection subscriptions, the status fetch and event socket for the selected session, and the footer paint loop.
- `src/metrics.ts` — pure model: token estimation, trailing-window TPS, context selection, count formatting, footer text, and CSS string quoting. No host access; unit-tested directly.
- `src/host-contract.ts` — the private PI WEB session status and event payloads, narrowed at the boundary. These routes are not public API; the host's `docs/plugins.md` lists internal routes as unsupported selectors, so every claim about them lives in this file and nowhere else.
- `src/plugin-api.ts` — a deliberately minimal mirror of the host's public browser contract (`@jmfederico/pi-web/plugin-api`, API v5). Depending on the host package for types would install its whole web application and its Pi peers for three definitions; keep the mirror aligned with the host version named in it.
- `src/footer.css` — the stylesheet contribution that hides the native footer spans and renders the plugin line through `.bar::after`.

## Global Working Rules

### Language-agnostic

- Never harden against hypotheticals. When a failure mode — a race, a security edge case, or anything else — is speculative or vanishingly unlikely, name the concrete failure, its likelihood, and the complexity the defense costs, then stop and let the user decide. Silent scope expansion for theoretical robustness is not diligence.
- English is the repository's written language: documentation, code, comments, and every user-facing string. Chinese appears only as test input for the CJK token estimator, never as prose.
- Never add source newlines to string literals, templates, or document files, and never wrap their content, solely to limit line length; preserve only semantically intentional line breaks.
- Always follow a documentation-first approach: update `AGENTS.md`, `README.md`, and code comments alongside every change. `README.md` addresses users of the published package; maintainer workflow belongs here.
- Be strict. Avoid fuzzy, ambiguous, or weakly specified behavior; make semantics explicit.
- Do not preserve backward compatibility in code. Implement the design in the most elegant and idiomatic form available; the package version is the compatibility surface.
- Prefer using the scripts defined in `package.json`.
- Name booleans with predicate-style name prefixes such as `is`, `can`, `has`, or `should`.
- Prefer unabbreviated names. For example, use `statusRevision` instead of `rev`. Exceptions: "ctx", "err", "repr", "src", "dst", "std", "id".
- Give every item the most restrictive visibility that permits its intended use.
- Trust first-party values; validate only what crosses a boundary. This repository's own types and configuration are first-party. Host payloads are not: every unknown session status or event is narrowed in `src/host-contract.ts`, and no other module re-checks a value that boundary already produced.
- Add comments for non-trivial or hard-to-understand logic.
- Keep folder-local `AGENTS.md` files focused on stable guidance. Do not include implementation details that must be updated after code changes.
- Follow test-driven development (TDD): write tests before implementing functionality.
- Quality gates: `npm run check` (Biome and `tsc --noEmit`), `npm test`, and `npm run verify:dist` (rebuild and prove `dist/` is current). Run all three before calling a change done; CI runs them on every push.
- Do not write trivial tests. Tests exist to protect complex logic, invariants, edge cases, and failure-prone paths, never to satisfy a ritual or verify self-evident modifications. Keep coverage cohesive: when functionality changes, update and consolidate existing tests instead of accumulating redundant cases. Test only first-party domain logic; never test upstream dependencies, libraries, or standard-library primitives.
- Test behavior through public boundaries with reachable inputs only. Never construct a state the types or an upstream gate already exclude to reach a branch. Never mock first-party modules: `src/pi-web-plugin.test.ts` stubs browser globals (`document`, `WebSocket`, `fetch`, `performance`) because the browser is the plugin's boundary, and those stubs are the repository's only test doubles.

### TypeScript

- Generic parameter naming is all-or-nothing per list. When a generic list is simple—a few distinct parameters with no overlapping roles—use single-letter generics. Otherwise, once any parameter needs a descriptive multi-letter name, make every parameter in that list multi-letter; never mix single-letter and multi-letter generics in the same list. Multi-letter generics carry a role prefix: `TXxx` for a type parameter and `FXxx` for a function or callback parameter, where `Xxx` describes the parameter's use.
- Use strict types and narrow unknown input through explicit validation. Do not use `any` or unchecked type assertions to bypass the type system. Use explicit return types for exported functions.
- Imports carry `.ts` extensions; the build and the test runner resolve them, and `tsc` runs with `allowImportingTsExtensions` and `noEmit`.
- Tests are Vitest files beside their module (`<module>.test.ts`), run from the repository root in the Node environment with explicit `vitest` imports. There is no DOM environment: browser globals are stubbed per test with `vi.stubGlobal`, and `vi.unstubAllGlobals()` restores them.
- The build is the Vite library configuration in `vite.config.ts`. Keep `base` relative and asset inlining off: the host serves the plugin from a revisioned subpath, and a stylesheet contribution must be a real HTTP(S) URL.

### Packaging

- `piWeb.plugins[0]` keeps `browserRoot: "dist"` and `module: "dist/pi-web-plugin.js"`. The module path is package-root-relative and must stay inside the browser root.
- Everything inside `dist/` is browser-public. Ship only the entry and its stylesheet; keep development files outside it. Biome ignores `dist/`, so never hand-format the generated output either.
- The package ships no runtime dependencies. Anything added to `dependencies` is installed for every user, so it needs an explicit reason; tooling belongs in `devDependencies`.
- Keep the installed package inside the host limits: 4,096 entries and 16 MiB, excluding `.git` and `node_modules`.

## Releasing

The package is published on npm as `pi-web-tokenline`, and `pi install git:github.com/EAimTY/pi-web-tokenline` follows the repository. A release is:

1. Run the quality gates: `npm ci`, `npm run check`, `npm test`, `npm run verify:dist`, `npm pack --dry-run`.
2. Bump the version with `npm version patch` (or `minor`/`major`), which updates `package.json` and `package-lock.json` together.
3. Publish with `npm publish --access public`. `prepack` rebuilds `dist/`, so a publish never packages an outdated module.
4. Push the commit and tag with `git push origin master --follow-tags`.

Validate a release in a real `@jmfederico/pi-web` instance before calling it stable: real-time output including thinking, multiple tool calls, prolonged stalls, context compaction, browser refresh and session switching, and native footer restoration after the plugin is disabled. Pi Web's session status and events routes and its `status-bar` markup are not a stable third-party contract, so re-check the footer after host upgrades.
