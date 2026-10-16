# Compatibility and troubleshooting

[Back to README](../README.md)

pi-transcript-ui presents tool summaries in interactive Pi sessions. Compatibility outside the tested surfaces below, including arbitrary combinations of UI extensions, is not assured.

## Tested hosts

| Pi host | Current test coverage |
| --- | --- |
| 1.3.0 | Primary suite: summaries, intent transport and persistence, native components, grouping, navigation and compositor fixtures |
| 1.1.0 | Shared UI/session/compositor fixtures, structured prompts and native codemode execution |
| 0.85.1 | Shared UI/session/compositor fixtures and legacy string prompts; no native codemode |

Each host uses matching versions of its Pi runtime dependencies, including core, AI and TUI, plus codemode and MCP where present. Vitest isolates test execution and binds this extension to the selected SDK/TUI. Compatibility hosts share a focused set of native UI, grouping/navigation, compositor and session/prompt checks. Unit, parser, detailed formatting and publication-workflow tests run only on the primary host.

Test admission follows release capabilities: structured prompt sections from 0.86.0, native codemode from 0.99.0, recorded tool duration from 1.1.0 and trigger-object prompt hooks from 1.2.0. Only the representative hosts listed above are exercised. These component, session and compositor-fixture tests do not establish complete interactive terminal sessions or compatibility with every release in those ranges.

[Codemode coverage](usage.md#codemode) includes real sandbox execution, partial updates, saved results and native expanded-body rendering. The extension does not add codemode to older hosts.

[Shell-session summaries](usage.md#shell-sessions) use provider-shaped requests and receipts with real native tool components. These tests do not execute the external providers or run the presentation extension through Pi's extension loader.

## Input support

Support depends on what is **active**, not merely installed.

| Active environment | Individual tool and group disclosure |
| --- | --- |
| Regular Pi without an external compositor | Keyboard |
| Pi native fullscreen without an external compositor | Mouse and keyboard |
| [pi-alternative-compositor](https://github.com/ejx537/pi-alternative-compositor) | Mouse; this extension's keyboard navigator is unavailable |

The alternative compositor is optional. For Pi's native fullscreen, start Pi with:

```sh
pi --tui-mode fullscreen
```

Disable the alternative compositor first if you use it. Combining it with native fullscreen is unsupported.

Existing Pi shortcuts remain available. In particular, the alternative compositor can remember per-item mouse choices that take precedence over Pi's Ctrl+O bulk toggle. This extension does not override those choices.

Mouse behavior can also depend on the terminal. These modes do not establish support for every terminal, input device or extension combination.

## Tool and provider support

Built-in, custom and MCP tools can receive compact summaries. Recognition of file operations depends on the tool's declared inputs, not just its name. Unrecognized custom tools may use generic labels or omit file counts. [Patch request summaries](usage.md#patch-requests) additionally inspect a bounded content format; matching fields do not establish what was actually applied.

Shell-session recognition checks the exact names and the supported direct request schema rather than treating every `exec_command` or `write_stdin` as interchangeable. Unsupported request variants keep generic/native presentation; unknown result metadata omits optional exit facts. Expanded calls retain the summary plus original body, as with other tools; provider-hidden bodies are not reconstructed or used to suppress native call identities.

Explicit Bash and zsh `exec_command` calls support Compact formatting with distinct syntax handling; Raw selections and missing/default or unsupported-shell calls stay Raw. See [shell-session details](usage.md#shell-sessions) for filename/schema limits and [preview rules](usage.md#command-previews) for zsh's bounded syntax and plain-text display. This does not change execution or the existing native `bash` and `powershell` tool rules.

Purpose text depends on the model, provider and tool supporting the intent request. It is discretionary even when supported. A missing purpose is not itself an error; the command or path can still be shown.

Unsupported UI components keep native presentation and produce a diagnostic rather than having their output reconstructed. Unusual renderers, image display and very large session histories are not covered by a blanket compatibility guarantee.

Summaries do not replace tool execution, permissions or expanded output. Command previews and line counts are not a security review, an execution trace or a complete filesystem diff.

## Intent prompt composition

On Pi hosts with structured system prompts, intent guidance uses the `pi_transcript_ui_intent` section. Other extensions can contribute sections before or after this hook. Turning intent off removes only this extension's section on the next prompt; changing its language replaces the section rather than appending another copy. Pi 0.85.1 lacks structured sections and retains the string-append path.

On structured hosts, an explicit full-prompt override from another extension remains authoritative. This extension does not clear or rewrite that override to insert intent guidance, so the guidance may be absent. Composing sections into another extension's opaque override is unsupported; it requires cooperation from the override's owner.

See [tested hosts](#tested-hosts) for shared UI checks and version-appropriate prompt coverage.

## Troubleshooting

### The commands are missing

Run `pi list` in a terminal to check installation, and use `pi config` to check that the extension is enabled. Then restart Pi or run `/reload`. `/transcript-ui` shows command help and the loaded extension version.

If you installed a local checkout, make sure the directory still exists at the installed path. See [installation](../README.md#install).

### Clicking a row does nothing

Regular Pi without a compositor supports keyboard disclosure only. Use `/transcript-ui tools`, or choose one of the mouse-capable environments above. Do not enable the alternative compositor and native fullscreen together.

### Keyboard navigation says to use the mouse

The alternative compositor is active. Use its mouse controls for individual tools and groups. This restriction does not disable the editor or settings dialogs.

### Ctrl+O does not change a previously clicked item

The alternative compositor may be retaining that item's mouse override. Toggle the item with the mouse; mixing its per-item overrides with keyboard bulk state is not supported by this extension.

### Commands or counts are cut off

The total row width includes markers, labels, status, counts and purpose text. A narrower terminal reduces it further. Command and intent widths are ceilings, not guaranteed space. See [width settings](settings.md#widths), or expand the tool for its original content.

Switching to Raw stops compact transformations; it does not remove width limits.

### A count or purpose is missing

Purpose text is optional. Result counts require usable evidence from a finished call; an image, incomplete output or unsupported tool may have no count. Patch counts labeled `requested` describe the input and may appear before execution finishes. Missing counts do not mean zero. See [counts and status](usage.md#counts-and-status).

### Settings cannot be loaded or saved

Invalid files are reported and left untouched. Correct the JSON or values using the [settings reference](settings.md), then run `/reload`.

If the file changed while the dialog was open, reopen the dialog and make the edit again. Avoid changing the same file from multiple sessions or editors at once. Check that the settings directory is writable if saving reports a filesystem error.
