# pi-transcript-ui

Compact tool summaries for [Pi](https://pi.dev), with optional purpose text and groups of adjacent calls.

```text
▸ Read 2 files (4 lines)
▾ Edited 2 calls (+3 -2)
  ▸ Edited src/config.ts (+2 -1) — Update configuration
  ▸ Edited src/defaults.ts (+1 -1) — Adjust defaults
▸ Ran npm test (exit 0) — Verify changes

▸ Compacted from 42,123 tokens
```

Groups and their calls expand independently. Compaction checkpoints have their own expandable rows.

## Install

Requires Pi and Node.js 22.19 or newer. Pi 1.3.0 is the primary tested host; see [tested hosts and limitations](docs/compatibility.md#tested-hosts) for other versions.

Choose one installation method to avoid loading duplicate copies. Remove an existing installation before switching methods.

```sh
pi install npm:pi-transcript-ui
```

This registers the extension in your Pi user configuration. Start Pi in your project, or run `/reload` if it is already running.

<details>
<summary>Version pinning, GitHub and local installations</summary>

To pin the npm version:

```sh
pi install npm:pi-transcript-ui@0.6.1
```

To install a tagged release from GitHub instead:

```sh
pi install git:github.com/isty2e/pi-transcript-ui@v0.6.1
```

If switching from GitHub to npm, first remove the Git installation:

```sh
pi remove git:github.com/isty2e/pi-transcript-ui
```

For a local checkout, run `pi install` with the checkout's absolute path. Pi keeps a reference to that directory, so keep it in place while the extension is installed.

</details>

## Use

Run `/transcript-ui` for help and the installed version.

- **Inspect details:** expand a tool to see its original call and output. Groups and their members have separate controls.
- **Navigate tools and groups:** run `/transcript-ui tools` or press **Ctrl+Shift+O** where supported.
- **Change settings:** run `/transcript-ui settings` to configure grouping, purpose text and display options. At the main settings menu, **Save** applies changes; **Cancel** discards them.

A compositor is not required. Mouse and keyboard support depend on the active display environment; see [input support](docs/compatibility.md#input-support).

Summaries and command previews are display aids, not executable replacement commands or proof that every displayed command ran. Tool execution, expanded tool output and session data remain Pi's own.

## Documentation

- [Reading summaries and navigating tools](docs/usage.md) — counts, status, command previews, shell sessions, Codemode and compaction.
- [Settings reference](docs/settings.md) — grouping, purpose text, widths, durations and display modes.
- [Compatibility and troubleshooting](docs/compatibility.md) — tested hosts, input support, tool compatibility and recovery.
