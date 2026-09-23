# Reading summaries and navigating tools

[Back to README](../README.md)

## Expand tools and groups

A collapsed row starts with `▸`; an expanded row starts with `▾` and keeps its summary above the original output. Expanding does not replace or reconstruct the tool's output.

Adjacent exploration calls, such as reads and searches, can form a group. Writes and edits can also group together. Open a group to reach its members, then expand the member you want to inspect. Group and member expansion are independent.

Groups can continue across completed assistant responses that contain only tool calls. Text, thinking, notices and streaming responses interrupt grouping. You can change which tools group in [settings](settings.md#grouping).

### Keyboard navigation

Run `/transcript-ui tools` or press **Ctrl+Shift+O**:

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a group or visible member |
| → | Expand the selected item, or enter an already open group's members |
| ← | Collapse the selected item, or select its parent if already closed |
| Enter / Space | Toggle the selected item |
| Escape | Return to the editor |

If your terminal cannot distinguish the shortcut, use the slash command. This navigator is unavailable while the alternative compositor is active; use the mouse there. See the [environment table](compatibility.md#input-support).

Pi's **Ctrl+O** remains its native bulk tool-output toggle. With the alternative compositor, an item previously toggled by mouse may retain its own state rather than follow that toggle.

## Paths

File and directory path labels keep the first segment and as many nearby parent directories as fit before the filename. For example, as space narrows:

```text
packages/ui/src/components/forms/Button.tsx
packages/…/components/forms/Button.tsx
packages/…/forms/Button.tsx
packages/…/Button.tsx
```

A path that fits is left unabridged, apart from home and display normalization. Root prefixes such as `/`, `~/` and `C:\` are retained when space permits. If the start and filename cannot fit together, the start is shortened first. A filename that is itself too long is shortened in the middle to keep its beginning and end. Extremely narrow rows may leave room for little more than an ellipsis.

This applies to recognized path labels, including compatible custom file tools, not search patterns or arbitrary strings. **Command preview** controls shell commands separately; Raw does not disable path-label shortening.

Shortening does not change the path sent to the tool or Read file counts. Different paths can have identical abbreviated labels; expand the tool to see the original path.

## Purpose text

A short purpose may appear at the end of a row, after `—`. It is optional: the model may omit it when the command or path already explains the work. Missing purpose text does not produce a generic substitute and leaves more room for the description.

The purpose and its preceding `—` use the theme's `thinkingText` color, the same token as thinking blocks. Their appearance follows the selected theme; command and status colors remain separate.

Available purpose text is retained when the session is reloaded. See [intent settings](settings.md#intent) for language and length controls.

## Counts and status

Counts depend on the tool and available result. There are no separate metric on/off settings.

### Read

Read counts describe returned text, not the full size of a file or the requested line limit.

```text
Read 3 files (420 lines)
Read 1 file (3 reads, 420 lines)
Read 3 files — 1 failed (partial 2/3: 420 lines)
```

- File counts distinguish requested paths. Different paths to the same physical file can count separately; the extension does not check filesystem aliases.
- Line totals add the returned text-body lines from each measured call. Repeated or overlapping reads count those lines again.
- `3 reads` distinguishes repeated calls from distinct files.
- `partial 2/3` means two of three calls contributed measurable counts. The denominator counts calls, not files.
- Images, errors, unfinished calls and ambiguous output are not counted as zero. An individual read can show `(lines unknown)`; a group with no usable counts omits the line total.

### Write

```text
Write notes.txt (42 lines)
Write empty.txt (0 lines)
```

A successful content write shows the size of the submitted text. A final newline does not add an extra line. This is not a change count: writing 42 lines may replace an existing file rather than add 42 new lines.

Failed or unfinished writes do not show this count. Custom writers that cannot be recognized or have no usable content may omit it. Counts for compatible custom writers assume they write the submitted content, not a transformed version of it.

### Edit and mutation groups

```text
Edit src/config.ts (+2 -1)
```

`+2 -1` means two added and one removed line in an available, complete single-file patch. When no reliable patch is available, the change count is omitted.

Group change totals add the available per-call patch counts, including patches from writes. They are not the net change to the filesystem: editing the same line twice can count it twice. Full Write content sizes are never added to these patch totals.

Recognized edit/write/patch groups use `Editing` while running and `Edited` once all calls settle; failures are marked separately. Groups count calls, not unique files. A partial total such as `(partial 1/2: +2 -1)` means only one of two calls supplied a usable result patch.

### Patch requests

Compatible patch inputs are recognized by their declared fields and content, without a provider registry. One native call still owns its original result and expanded output.

```text
Patch src/config.ts (requested +2 -1)
Patch old.ts → new.ts (requested +0 -0)
Patch 2 targets (requested +3 -1)
Patch old.ts (requested)
Edited 2 calls (requested 3 targets: +3 -1)
Patch src/config.ts — error (requested +2 -1)
```

**`requested` describes input, not confirmed filesystem changes.** Counts remain requests while running, after success or after failure; the native result determines the call's error marker. Context lines do not count as additions or removals. Deletions do not include the old contents, so a request containing a deletion omits the entire `+/-` total rather than reporting zero removed lines.

A target is one requested file-operation entry. Repeated entries for the same path count separately; a move is one entry retaining both paths. Groups count native calls, not target entries. Patch-only groups can sum requested counts. Mixed edit/write/patch groups never add requested counts to applied-result totals; expand the members to see individual requests.

Recognition covers bounded direct object schemas and either:

- Exactly one required string field named `input`, `patch` or `patchText`, containing `*** Begin Patch` / `*** End Patch`, Add/Update/Delete File sections, and optional `*** Move to:` immediately after an Update header. Updates need nonempty `@@` hunks with explicit space, `+` or `-` prefixes; an optional `*** End of File` marker must end the update body.
- Required string `type` and `path` fields plus a declared string `diff` field. `create_file` takes addition-prefixed text, `update_file` takes headerless `@@` hunks, and `delete_file` omits `diff`.

LF and CRLF are accepted. Recognition is limited to 65,536 UTF-16 units per payload, 4,096 lines, 256 target entries and 4,096 units per path. Ambiguous fields, incomplete envelopes, unsupported syntax or schemas, control-bearing paths, ambiguous whitespace around envelope paths and oversized inputs use the existing fallback. A later argument update can establish or revoke recognition and regroup adjacent calls. Explicit grouping preferences still take precedence.

This is not a patch-applicability validator or proof that the tool mutates files. Custom tools using the same shape for another purpose can override grouping in settings. Alternate Create/Edit envelope dialects, lenient unprefixed bodies, schema references/compositions, freeform transports, provider-specific applied receipts and phase outcomes are outside this support. No files are read to reconstruct missing counts.

### Failures and unavailable counts

`— error` marks an individual failure; `— N failed` marks failures in a group. Failure status and partial measurement are separate: a successful call may still have no usable count.

A known zero is shown as zero. An unavailable count is omitted or marked unknown. On narrow screens, some labels or totals may be clipped; expand the tool to inspect the original result.

Bash summaries do not show output-line totals.

## Command previews

In **Compact** mode, long or multiline Bash commands can keep several command names and separators visible instead of spending all the space on the first command's arguments. Simple newline-separated commands use `↵`; newlines after `&&`, `||` or `|` retain that operator, and backslash-newline continuations outside single quotes do not create another command.

For example, three lines containing `set -euo pipefail`, `npm test` and `git diff --check` can appear as:

```text
Run set -euo pipefail ↵ npm test ↵ git diff --check
```

Shell settings such as `set` are displayed as ordinary commands, not hidden or classified as setup.

| Marker | Meaning |
| --- | --- |
| `↵` | A newline separating outer commands |
| `…/name` | A slash-shaped argument was shortened |
| `[env]` | Environment assignments were abbreviated |
| `$(…)` | Command-substitution contents were omitted |
| `cat […]` | A confirmed heredoc was omitted, or the command has an unsupported remainder |
| `if […]` | An unsupported remainder is shown without its details |
| `[+N]` | Exactly N additional commands were omitted |
| `[more]` | More syntax was omitted, but the full omitted command count is unknown |
| `…` | Text was clipped to fit |

Slash-shaped arguments can be shortened even when they are not filesystem paths. A preview shows requested syntax, not which branches actually executed. It is not a copyable replacement command. Neither mode is secret redaction; sensitive argument values may remain visible.

Compact Bash previews use Pi's syntax colors from the original command; generated markers use the theme's muted color. Coloring is best effort: retained text with verified original-source positions keeps its syntax colors, while opaque regions remain plain. Oversized or control-bearing commands and unsupported highlighting output can still leave the whole preview uncolored. Failed rows keep their error color. Raw and PowerShell previews are unchanged.

Confirmed heredocs are omitted locally, so their surrounding commands remain visible. For example:

```bash
cd foo && python <<'PY' | grep -i "bar"
print("bar")
PY
git status
```

With enough space, the preview is:

```text
Run cd foo && python […] | grep -i "bar" ↵ git status
```

Compact recognizes `<<` and `<<-` after a command name, with nonempty delimiter names made of letters `A–Z`/`a–z`, digits, `_`, `.`, `+` or `-`, either bare or entirely single- or double-quoted. Multiple heredocs are consumed in declaration order. Closing delimiters must occupy a whole logical line; `<<-` permits leading tabs, not spaces. For unquoted delimiters, backslash-newline continuations are joined before checking the closing delimiter. Body text and closing delimiters never count as outer commands. The preview does not evaluate body expansions.

Compact does not fully parse shell scripts. Here-strings (`<<<`), heredocs inside command substitutions, redirections before the command name, other delimiter spellings, quoted newlines and other unsupported syntax remain out of scope. These cases, or an unconfirmed heredoc boundary, retain earlier recognized commands followed by one opaque remainder such as `python […]`; scanning does not resume beyond that remainder. This conservative boundary avoids presenting body text as commands. Unsupported initial single-line syntax and commands too large to compact use a first-line preview; multiline fallback also marks omitted content with `[…]`.

PowerShell always uses the raw first-line form.

Choose **Raw** in [command preview settings](settings.md#command-preview) to bypass compact transformations. Both modes obey the row and field width limits; neither changes execution or expanded output.
