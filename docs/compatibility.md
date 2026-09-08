# Compatibility and troubleshooting

[Back to README](../README.md)

pi-transcript-ui presents tool summaries in interactive Pi sessions. Pi 0.85.1 is the checked runtime version. Other versions and arbitrary combinations of UI extensions are not assured to work.

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

Built-in, custom and MCP tools can receive compact summaries. Recognition of file operations depends on the tool's declared inputs, not just its name. Unrecognized custom tools may use generic labels or omit file counts.

Purpose text depends on the model, provider and tool supporting the intent request. It is discretionary even when supported. A missing purpose is not itself an error; the command or path can still be shown.

Unsupported UI components keep native presentation and produce a diagnostic rather than having their output reconstructed. Unusual renderers, image display and very large session histories are not covered by a blanket compatibility guarantee.

Summaries do not replace tool execution, permissions or expanded output. Command previews and line counts are not a security review, an execution trace or a complete filesystem diff.

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

Purpose text is optional. Counts require usable evidence from a finished call; an image, incomplete output or unsupported tool may have no count. Missing counts do not mean zero. See [counts and status](usage.md#counts-and-status).

### Settings cannot be loaded or saved

Invalid files are reported and left untouched. Correct the JSON or values using the [settings reference](settings.md), then run `/reload`.

If the file changed while the dialog was open, reopen the dialog and make the edit again. Avoid changing the same file from multiple sessions or editors at once. Check that the settings directory is writable if saving reports a filesystem error.
