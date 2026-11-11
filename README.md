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

Notes:

- Mouse reporting is on while fullscreen, so select text with Shift+drag.
- Finished messages reach the shell's scrollback when the mode is turned off or omp exits.
- It patches pi-tui internals at runtime (built against omp 18.18.x); an omp update can
  break it. `/fullscreen off` or `OMP_FULLSCREEN=0` falls back to the normal screen.
