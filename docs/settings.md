# Settings reference

[Back to README](../README.md)

Run `/transcript-ui settings` inside Pi and choose a category:

- **Grouping** — Exploration, Mutation and Standalone tool lists.
- **Intent** — Purpose text, language and generation length.
- **Display** — Command preview mode and summary widths.

Changes stay in one draft as you move between categories. Choose **Back** or press Escape inside a category to return to the main settings menu. Cancelling an individual field editor or chooser returns to its category without changing that option.

At the main settings menu, **Save** saves and applies all draft changes immediately. **Cancel** or Escape discards the entire draft.

## Grouping

Enter one exact tool name per line, not the displayed label: for example, `read`, not `Read`. Custom and MCP tools use the names supplied by their extensions or servers. A name cannot appear in more than one list.

| Menu option | JSON key | Default |
| --- | --- | --- |
| Exploration tools | `grouping.exploration` | `read`, `grep`, `find`, `ls` |
| Mutation tools | `grouping.mutation` | `edit`, `write` |
| Standalone tools — exclude auto-grouping | `grouping.standalone` | Empty |

Compatible custom file-writing and editing tools can group automatically, even if their names are not listed. To keep one separate, remove it from any explicit grouping list and add it to **Standalone tools — exclude auto-grouping**.

Removing a built-in tool from its default list disables its grouping. Saved list choices take precedence over automatic grouping. Bash and PowerShell normally stay separate unless explicitly grouped or recognized as file-mutation tools.

Mixed tool groups may have generic labels such as “Exploration … calls” or “Mutation … calls”, rather than claim that every member read or changed a file.

## Intent

Intent is the optional purpose text at the end of a summary.

| Menu option | JSON key | Default | Values |
| --- | --- | --- | --- |
| Intent | `intent.enabled` | On (`true`) | On / Off |
| Intent language | `intent.language` | `auto` | `auto`, `en`, `zh-CN` |
| Intent generation length | `intent.maxLength` | 48 | Integer, clamped to 16–256 Unicode code points |

Turning intent off stops requesting purpose text and hides it in summaries. It does not delete saved session history.

`auto` asks for the user's language; `en` asks for English and `zh-CN` for Simplified Chinese. These settings guide the model; they do not require every call to include a purpose or translate previously saved text.

Generation length and display width are different limits. Generation length counts Unicode code points; display width counts terminal columns. For example, many CJK characters occupy two columns. Display clipping does not change the tool's arguments or output.

## Widths

| Menu option | JSON key | Default | Values |
| --- | --- | --- | --- |
| Total row width | `display.rowMaxWidth` | 120 | Integer, 1–4096 terminal columns |
| Command display width | `display.commandMaxWidth` | 120 | Integer, 1–4096 terminal columns |
| Intent display width | `display.intentMaxWidth` | 48 | Integer, 1–4096 terminal columns |

**Total row width** caps the whole summary, including indentation, the expansion marker, description, status, counts and purpose. The viewport can impose a smaller limit. Expanded output is not subject to this summary cap.

Command and intent widths are additional ceilings, not reserved allocations. Space is shared: short or absent purpose text leaves more room for the description. Increasing command width alone may have no effect if the total row or terminal is already the limiting factor.

To show longer commands, increase the total row and command limits as needed, widen the terminal, or reduce the intent display limit. Purpose text remains at the end of the row.

## Command preview

| Menu option | JSON key | Default | Values |
| --- | --- | --- | --- |
| Command preview | `display.commandPreview` | Compact (`"compact"`) | Compact (`"compact"`) / Raw (`"raw"`) |

**Compact** shortens supported Bash syntax to keep command names and separators visible. See the [preview markers](usage.md#command-previews).

**Raw** shows the original first line within the same width limits, without compact structure, path, environment or substitution transformations. Tabs and carriage returns are normalized for display. Raw does not mean unbounded or byte-for-byte output.

PowerShell uses the raw first-line form in either mode. Neither mode changes execution or expanded output.

## Settings file

You do not need to edit JSON to use the settings menu. For manual editing, the default file is:

```text
~/.pi/agent/extensions/pi-transcript-ui/settings.json
```

If you configure a different Pi agent directory, the `extensions/pi-transcript-ui/settings.json` suffix is relative to that directory. Set `PI_TRANSCRIPT_UI_SETTINGS` before starting Pi to override the complete file path.

The file is created only when you save. After editing it outside Pi, run `/reload` to apply the changes.

### Default configuration

```json
{
  "version": 1,
  "grouping": {
    "exploration": ["read", "grep", "find", "ls"],
    "mutation": ["edit", "write"],
    "standalone": []
  },
  "intent": {
    "enabled": true,
    "language": "auto",
    "maxLength": 48
  },
  "display": {
    "rowMaxWidth": 120,
    "commandMaxWidth": 120,
    "intentMaxWidth": 48,
    "commandPreview": "compact"
  }
}
```

Unknown keys and invalid values are reported rather than silently discarded. The generation-length integer is the exception to range rejection: it is clamped to 16–256. Each tool list supports up to 4,096 names, each at most 512 UTF-16 code units; names must be nonblank and contain no control characters. The file must not exceed 1 MiB.

Older version-1 files may omit `display`, individual display fields or `grouping.standalone`. Missing values receive defaults without rewriting the file. Explicitly saved values are preserved within the supported ranges. If an older file lacks standalone exclusions, add any custom tools you want to keep separate; past removals from positive grouping lists cannot establish those exclusions.

Loading or cancelling does not write the file. Saving checks whether the file changed since the dialog opened and refuses an observed conflict; reopen the dialog before retrying. This is not a lock against simultaneous writers, so avoid editing the same settings file concurrently.
