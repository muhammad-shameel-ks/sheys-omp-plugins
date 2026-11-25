# sheys-omp-plugins

[![check](https://github.com/muhammad-shameel-ks/sheys-omp-plugins/actions/workflows/check.yml/badge.svg)](https://github.com/muhammad-shameel-ks/sheys-omp-plugins/actions/workflows/check.yml)

Personal [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) plugins.

## Install

```sh
omp plugin install github:muhammad-shameel-ks/sheys-omp-plugins
```

Update or remove:

```sh
omp plugin install github:muhammad-shameel-ks/sheys-omp-plugins --force
omp plugin uninstall sheys-omp-plugins
```

Working from a clone instead (edits apply on the next omp start):

```sh
git clone https://github.com/muhammad-shameel-ks/sheys-omp-plugins
omp plugin link ./sheys-omp-plugins
```

## Compatibility

Tested against omp 18.18.x and 19.0.1.
These plugins read pi-tui internals, so an omp update can move them out from under the code.

```sh
pnpm smoke
```

The smoke test loads both extensions in a headless omp and fails if either no longer registers its command.
It catches broken host imports, which is how an omp update usually breaks these plugins.
It needs `omp` on `PATH`.

```sh
pnpm typecheck
```

Type checks both plugins against the published 19.0.1 host types.

```sh
pnpm check
```

Runs both checks in one go; that is the CI entry point.

## Fullscreen

Claude Code / Pi style fullscreen mode: the transcript scrolls inside the terminal's
alternate screen while the editor, status line and widgets stay pinned to the bottom.
On by default.

```
┌────────────────────────────────────────────┐
│ transcript (scrolls)                       │
│ • assistant text                           │
│ • 13 commands, 9 thoughts  (ctrl+o)        │
│            ↓ 42 more lines                 │
├────────────────────────────────────────────┤
│ pending messages, todos, working row       │
│ ┌ editor ───────────────────────────────┐  │
│ │ your draft                            │  │
│ └───────────────────────────────────────┘  │
│ status line                         70% ▍  │
└────────────────────────────────────────────┘
```

| Action | Input |
|---|---|
| Scroll | mouse wheel, PgUp / PgDn |
| Jump to latest / top | Ctrl+End / Ctrl+Home, or click the `↓ N more lines` bar |
| Toggle | `/fullscreen [on\|off]`; `OMP_FULLSCREEN=0` starts with it off |
| Copy | drag over the transcript or the composer; it copies on release (drag past the top or bottom edge of the transcript to scroll). A click or any key clears the highlight |

Notes:

- Selection covers the transcript and the composer (your draft, status line). Copying from
  the composer drops the frame's border glyphs. The terminal's own selection still works
  with Shift+drag (Option+drag in iTerm2).
- Finished messages reach the shell's scrollback when the mode is turned off or omp exits.
- It patches pi-tui internals at runtime (tested against omp 18.18.x and 19.0.1); an omp update can
  break it. `/fullscreen off` or `OMP_FULLSCREEN=0` falls back to the normal screen.
- If a frame throws, the error goes to omp's log, the mode turns itself off and the normal screen
  comes back, so a host change cannot wedge the UI. `/fullscreen on` retries.
- The patches install when the mode first starts, so `OMP_FULLSCREEN=0` leaves the host untouched
  until you switch it on. A second extension that wraps `Composer.renderFrame` or `TUI.showOverlay`
  must call the method it replaces.

## Tool groups

Claude Code style tool grouping: each run of tool calls between two pieces of assistant text
collapses into one summary row.

```
• 13 commands, 9 thoughts, 4 reads  (ctrl+o to expand)
```

| Action | Input |
|---|---|
| First-time setup | `/toolgroups on` (turns on omp's *Extension Transcript Presenters* setting, which is off by default) |
| Expand / collapse one group | click its summary row; click the title row of any of its cards to fold it again (fullscreen mode) |
| Expand / collapse all | Ctrl+O |
| Toggle | `/toolgroups [on\|off]`; `OMP_TOOLGROUPS=0` starts with it off |
| Usage rows | `/toolgroups stats [final\|all]`; `OMP_TOOLGROUPS_STATS=all` keeps every row |

Notes:

- While the agent works, the newest call stays visible under the summary; it folds in when the run ends.
  A group of one call shows omp's own one-row summary.
- Edits, writes, subagent tasks, `ask` and todo updates are never grouped: they draw in full and end the group.
- With `display.showTokenUsage`, omp adds a stats row after every model request. Rows of requests that
  ended in tool calls are hidden, so each turn keeps one row under its final answer. This part patches
  pi-tui internals; it switches itself off if an omp update moves them, and a failed tag only logs a
  warning instead of breaking the transcript.
- While a group is live, its summary shimmers with omp's native shimmer, so `display.shimmer`
  selects classic or KITT (fullscreen mode only; disabled stops it, as do reduced/no Motion).
- While a group is live, omp's live `Thinking…` pulse is hidden: the summary already counts it
  (fullscreen mode only).
- Finished thoughts are counted but drawn by omp as usual (hide them with `hideThinkingBlock`).
- Built on omp's public transcript presenter API, so it should survive omp updates better than Fullscreen.
  Without Fullscreen, Ctrl+O only re-expands blocks still on screen (stock omp behavior); with it, every group expands.

## Gemini Agent (`agy-acp`)

T3-Code-style Gemini Agent (Antigravity CLI, `agy`) ACP provider for `omp` using your native `/login` and `/models` flows:

- Adds an `agy` entry (`Gemini Agent`) directly in `/login`.
- Exposes Gemini Agent models natively under `agy/...` in `/models` (discovered dynamically from `agy acp`).
- Spawns unmodified `agy acp --stdio` with `clientInfo.name = "zed"` (no `--agent bridge`,
  no `_meta.antigravity.systemPrompt.append`, and no loopback MCP tool hijacking).

Notes:

- Requires `agy` installed on `PATH` (or `OMP_AGY_ACP_BIN=/path/to/agy`).
- `/login` -> `agy` verifies any existing `agy` login or runs ACP authentication (`oauth-personal`,
  `oauth-business`, `gemini-api-key`, `agent-platform`).
- Optional environment variables:
  - `OMP_AGY_ACP_CLIENT`: override ACP `clientInfo.name` (defaults to `zed`, which exposes the full Gemini + Claude + GPT-OSS catalog).
  - `OMP_AGY_APPROVE`: permission policy (`ask`, `accept-edits`, or `auto`; defaults to `ask`).
  - `OMP_AGY_FORCE_FILE_STORAGE=1`: sets `AGY_ACP_FORCE_FILE_STORAGE=1` when spawning `agy`.
- `/usage` reads limits using `agy`'s own saved sign-in (keychain or token file), as T3 Code does; the token is never stored by omp.

## License

MIT.

