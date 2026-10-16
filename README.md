# pi-transcript-ui

Compact tool summaries for Pi, with optional purpose text and groups of adjacent calls. Tool execution and expanded output remain Pi's own.

A collapsed Read group, an expanded Edit group, [shell-session calls](docs/usage.md#shell-sessions) and [native codemode](docs/usage.md#codemode):

```text
▸ Read 2 files (4 lines)
▾ Edited 2 calls (+3 -2)
  ▸ Edited src/config.ts (+2 -1) — Update configuration
  ▸ Edited src/defaults.ts (+1 -1) — Adjust defaults
▸ Ran npm test (exit 0) — Verify changes
▸ Checked output (exit 0)
▸ Ran code read ×2, bash (3 nested calls) (1.2s)
```

Expand an individual call to see its original output. Read groups count files; mutation groups count calls, not unique files. Counts are shown only when usable evidence is available.

Action labels follow the call's phase, such as `Run` → `Running` → `Ran`. Completed calls use the past tense even on failure; existing error colors and markers show the outcome. See [labels and status](docs/usage.md#counts-and-status).

Individual summaries show recorded tool duration by default when available. Turn it off under **Display → Tool duration**; the same setting applies to codemode and other tools. See [duration details](docs/usage.md#tool-duration).

## Install

Requires [Pi](https://pi.dev) and Node.js 22.19 or newer. Pi 1.3.0 is the primary tested host; compatibility with other versions is not assured.

Shared UI checks also run on Pi 1.1.0 and 0.85.1, with prompt and codemode cases selected by host capabilities. These are not complete interactive terminal tests. See [tested hosts and coverage](docs/compatibility.md#tested-hosts) for scope and limitations.

Install from npm (recommended):

```sh
pi install npm:pi-transcript-ui
```

This registers the extension in your Pi user configuration. To pin a specific version, use `pi install npm:pi-transcript-ui@0.4.0`.

Alternatively, install the tagged release from GitHub:

```sh
pi install git:github.com/isty2e/pi-transcript-ui@v0.4.0
```

Choose one installation method to avoid loading duplicate copies. If switching from GitHub to npm, first remove the Git installation with `pi remove git:github.com/isty2e/pi-transcript-ui`.

To use a local checkout instead, run `pi install /path/to/pi-transcript-ui`. Pi keeps a reference to that directory, so keep it in place while the extension is installed.

Start Pi in the project you want to work on. If Pi is already running, use `/reload`. Run `/transcript-ui` inside Pi to see the available commands.

## Use

Type `/transcript-ui ` to see subcommand completions. Use Tab to complete a name, such as `/transcript-ui se` → `/transcript-ui settings`. With no argument, or with `help`, the command shows help and the installed version.

- Expand a tool to see its original call and output. Groups and their members have separate controls.
- Run `/transcript-ui tools` or press **Ctrl+Shift+O** to open keyboard navigation where supported.
- Run `/transcript-ui settings` and choose **Grouping**, **Intent** or **Display**. **Back** or Escape returns from a category without losing edits. At the main settings menu, **Save** applies the draft; **Cancel** or Escape discards it.

Mouse and keyboard support depend on the active display environment. A compositor is not required. See [input support and troubleshooting](docs/compatibility.md).

## Customize

The default summary width is 120 terminal columns, or the available viewport width if narrower. Purpose text stays at the end of the row.

**Command preview** offers two modes:

- **Compact** (default): shares space across command names and shortens supported Bash syntax.
- **Raw**: shows the original first line within the same width limits, without compact transformations. `[…]` marks omitted non-blank lines when space permits.

Summaries are not executable replacement commands or proof that every displayed command ran. Expand the tool when you need exact arguments or output.

## Documentation

- [Reading summaries and navigating tools](docs/usage.md)
- [Settings reference](docs/settings.md)
- [Compatibility and troubleshooting](docs/compatibility.md)
