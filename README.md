# sheys-omp-plugins

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

## Fullscreen

Claude Code / Pi style fullscreen mode: the transcript scrolls inside the terminal's
alternate screen while the editor, status line and widgets stay pinned to the bottom.
On by default.

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
- It patches pi-tui internals at runtime (built against omp 18.18.x); an omp update can
  break it. `/fullscreen off` or `OMP_FULLSCREEN=0` falls back to the normal screen.

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
  pi-tui internals and switches itself off if an omp update moves them.
- While a group is live, its summary shimmers (fullscreen mode only, and not with `display.shimmer: disabled`).
- Thoughts are counted but drawn by omp as usual (hide them with `hideThinkingBlock`).
- Built on omp's public transcript presenter API, so it should survive omp updates better than Fullscreen.
  Without Fullscreen, Ctrl+O only re-expands blocks still on screen (stock omp behavior); with it, every group expands.
