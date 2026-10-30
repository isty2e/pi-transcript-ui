# Reading summaries and navigating tools

[Back to README](../README.md)

## Commands

Run `/transcript-ui` or `/transcript-ui help` to see available commands and the installed version. Type `/transcript-ui ` with a trailing space to see subcommand completions. Use Tab to complete a name, such as `/transcript-ui se` → `/transcript-ui settings`.

## Expand tools and groups

Collapsed headers start with `▸`; expanded headers start with `▾`. An expanded tool row keeps its summary above the original output. Expanding does not replace or reconstruct the tool's output.

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

## Compaction

Each recorded compaction checkpoint has its own row:

```text
▸ Compacted from 42,123 tokens
```

Expand it to see the original summary, native billing and recognized producer explanation/usage entries linked to that checkpoint. Unknown or unlinked entries stay visible in their original positions. The recorded pre-compaction context size is distinct from tokens billed; it is not a measured reduction or an after-count.

Pi's native bulk output toggle also controls checkpoint details. In mouse-capable environments, click the header for independent disclosure. Checkpoints are not tool calls, do not join tool groups and are not included in the tool keyboard navigator.

The active provider-native checkpoint can show a conditional warning when it has no portable summary and its declared provider/API differs from the current model:

```text
▸ Compacted from 42,123 tokens · ⚠ Current model cannot reuse checkpoint
```

Changing models on the same declared provider/API does not by itself produce this warning. Historical checkpoints, portable summaries and missing route facts are quiet. This is a display-only route diagnostic, not validation of checkpoint data, authentication or replay readiness. Compaction execution, errors and provider-switch behavior are unchanged.

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

Recognized action labels track the call's phase: `Run` before execution is confirmed, `Running` during execution and `Ran` once a final result is available. The same rule gives `Reading` / `Read`, `Writing` / `Wrote`, `Patching` / `Patched` and `Exploring` / `Explored`. Unknown activity keeps a neutral label; an old call is not assumed to be running merely because its session was reopened.

Completed tense records that a call ended, not that it succeeded. Failed calls keep the same completed verb with the existing error color and marker; group failures retain their separate failed count. Requested changes remain requests, and finishing an exec or input call does not establish process exit or application acknowledgement. Unrecognized tool names and titles inside original expanded output are unchanged.

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
Wrote notes.txt (42 lines)
Wrote empty.txt (0 lines)
```

A successful content write shows the size of the submitted text. A final newline does not add an extra line. This is not a change count: writing 42 lines may replace an existing file rather than add 42 new lines.

Failed or unfinished writes do not show this count. Custom writers that cannot be recognized or have no usable content may omit it. Counts for compatible custom writers assume they write the submitted content, not a transformed version of it.

### Edit and mutation groups

```text
Edited src/config.ts (+2 -1)
```

`+2 -1` means two added and one removed line in an available, complete single-file patch. When no reliable patch is available, the change count is omitted.

Group change totals add the available per-call patch counts, including patches from writes. They are not the net change to the filesystem: editing the same line twice can count it twice. Full Write content sizes are never added to these patch totals.

Recognized edit/write/patch groups use `Editing` while running and `Edited` once all calls settle; failures are marked separately. Groups count calls, not unique files. A partial total such as `(partial 1/2: +2 -1)` means only one of two calls supplied a usable result patch.

### Patch requests

Compatible patch inputs are recognized by their declared fields and content, without a provider registry. One native call still owns its original result and expanded output.

```text
Patched src/config.ts (requested +2 -1)
Patched old.ts → new.ts (requested +0 -0)
Patched 2 targets (requested +3 -1)
Patched old.ts (requested)
Edited 2 calls (requested 3 targets: +3 -1)
Patched src/config.ts — error (requested +2 -1)
```

**`requested` describes input, not confirmed filesystem changes.** Counts remain requests while running, after success or after failure; the native result determines the call's error marker. Context lines do not count as additions or removals. Deletions do not include the old contents, so a request containing a deletion omits the entire `+/-` total rather than reporting zero removed lines.

A target is one requested file-operation entry. Repeated entries for the same path count separately; a move is one entry retaining both paths. Groups count native calls, not target entries. Patch-only groups can sum requested counts. Mixed edit/write/patch groups never add requested counts to applied-result totals; expand the members to see individual requests.

Recognition covers bounded direct object schemas and either:

- Exactly one required string field named `input`, `patch` or `patchText`, containing `*** Begin Patch` / `*** End Patch`, Add/Update/Delete File sections, and optional `*** Move to:` immediately after an Update header. Updates need nonempty `@@` hunks with explicit space, `+` or `-` prefixes; an optional `*** End of File` marker must end the update body.
- Required string `type` and `path` fields plus a declared string `diff` field. `create_file` takes addition-prefixed text, `update_file` takes headerless `@@` hunks, and `delete_file` omits `diff`.

LF and CRLF are accepted. Recognition is limited to 65,536 UTF-16 units per payload, 4,096 lines, 256 target entries and 4,096 units per path. Ambiguous fields, incomplete envelopes, unsupported syntax or schemas, control-bearing paths, ambiguous whitespace around envelope paths and oversized inputs use the existing fallback. A later argument update can establish or revoke recognition and regroup adjacent calls. Explicit grouping preferences still take precedence.

This is not a patch-applicability validator or proof that the tool mutates files. Custom tools using the same shape for another purpose can override grouping in settings. Alternate Create/Edit envelope dialects, lenient unprefixed bodies, schema references/compositions, freeform transports, provider-specific applied receipts and phase metadata are outside this support. No files are read to reconstruct missing counts.

### Shell sessions

Compatible `exec_command` and `write_stdin` calls use request-oriented summaries:

```text
Ran npm test
Ran npm test (exit 7)
Checked output
Sent input
```

Recognition requires the exact tool name and a bounded direct object schema: required string `cmd` for `exec_command`, or required numeric `session_id` and declared string `chars` for `write_stdin`. Every declared required field must be present with a defined value before recognition; missing fields are not filled from schema defaults.

An `exec_command` call can use a Bash or zsh preview when the tool declares a string `shell` field and the call explicitly supplies an executable whose final filename is `bash`, `bash.exe`, `zsh` or `zsh.exe`. Installation directories do not matter: `/usr/local/bin/bash`, `/opt/homebrew/bin/zsh` and `C:\Program Files\Git\bin\bash.exe` qualify. **Command preview** still selects Compact or Raw; see the [preview rules](#command-previews) for supported syntax and colors. This recognizes the supported single-executable request contract, not the contents of a binary. Shell command lines such as `zsh -fc` are not decoded.

Other commands keep an unparsed first-line preview without shell colors. An omitted shell is not inferred from platform defaults, settings or the environment; fish, sh and PowerShell are not treated as Bash or zsh. Non-whitespace source on later lines adds `[…]` when space permits: `Ran cd repo […] (exit 0)`. Trailing blank or whitespace-only lines do not add the marker. A blank first line uses generic/native presentation instead of an empty command label. The exit code describes the whole call, not just the displayed line.

For the supported plain-string input contract, omitting optional `chars` or providing an empty string selects `Checking output` / `Checked output`; any nonempty string, including whitespace or control input, selects `Sending input` / `Sent input`. The summary does not echo the input or show a session ID. Nonempty binary input, unknown input fields, ambiguous defaults, unsupported schemas and malformed summary inputs keep the existing generic/native presentation. This is not a decoder for provider-specific input formats.

An exit code appears only after the call settles and supported result metadata supplies it. Recognized receipt shapes use `output` and `wall_time_seconds` with `exit_code`, `chunkId` and `wallTimeSeconds` with `exitCode`, or matching `tool`, `status: "exited"`, `output` and `durationMs` with `exitCode`. Missing, malformed or conflicting codes are omitted, not treated as success. Exit codes do not determine the native `— error` marker, and the summary does not infer whether a process is still running. Recognized shell summaries omit output-line totals; a group containing one also omits the group-wide output-line total. Groups still count native calls.

Expanded shell calls keep the same layout as other tools: a leading blank line, the summary row with any purpose text, then the complete original native rendering. The summary remains available for disclosure while waiting for a result and after completion, even if the provider hides its own title or body. Removing duplicate native titles is outside this support; a different policy is deferred until a shared disclosure and purpose-text contract is agreed for all tools.

This changes presentation only; full argument validation remains with the provider. It does not join calls by session ID, reconstruct the command behind `write_stdin`, split scripts into tools or recursively rewrite another extension's nested text components. File-operation recognition takes precedence over these shell summaries.

### Codemode

Pi's native `codemode` uses **Independent items (indented)** by default:

```text
▾ Ran code read ×2, bash (3 nested calls) (1.2s)
  ▸ Call
  ▸ Read 2 calls
  ▸ Ran npm test (0.4s)
  ▸ Script output
```

The execution row folds the whole codemode container. Opening it reveals Call, activities and Script output with their own disclosure and navigation targets; folding and reopening the parent preserves their expansion state. Native expand-all controls still apply to the whole container. Adjacent eligible activity can group within that one codemode call, using the normal grouping settings. Groups can count known requested file paths without a result; missing or ambiguous targets keep call counts, and absent results never contribute zero output lines. The execution row retains the parent's summary and purpose; Call is a separate display section, not a new execution record. Groups of top-level calls still count actual codemode parents, not their activity items.

Script output has three presentations:

- When live output can be traced and matches the final result, it opens into text, return-value, console and image items, plus any remaining native notices or errors. Each item has its own control; one item remains a single Script output row.
- Without that evidence, a complete ordered sequence of standalone `==> text 1/N <==` through `==> text N/N <==` lines produces numbered output sections. This uses printed formatting, not inferred `text()` calls or tool ownership. The redundant numbered headers are omitted from section bodies; payload text, images, console/error suffixes and any preceding content are preserved. The original result remains unchanged. Literal text deliberately using the same complete format can therefore be divided into display sections too.
- Incomplete, repeated or inconsistent numbering, or a native full-output spill reference, keeps the combined output. Truncation notices and full-output paths are preserved; no hidden or redacted raw output is restored.

Script output bodies use Pi's default text and media display without a tool-card background or added top/bottom padding, not an external tool renderer. The horizontal output padding setting still applies; blank lines in the output and native image spacing remain intact. Complete JSON containers receive two-space structural indentation on display copies. Arrays containing only numbers, strings, booleans or null stay on one logical line and wrap naturally at the terminal width; arrays containing objects or arrays use block layout. Number spellings, duplicate keys, key order, strings and escapes are preserved. Plain text, standalone scalar JSON values, incomplete JSON and mixed logs stay unchanged. Result envelopes and strings containing JSON are not decoded.

Formatting falls back to the complete original text if the supplied or proposed display text exceeds 50 KiB or 2,000 logical lines across the result, or formatting fails. These are formatting limits, not tool-output truncation limits.

Only the final native result is displayed, and the original combined content remains unchanged. Script output is not assigned to nested tools, deduplicated against their results or reconstructed by parsing JavaScript. External renderers' generic styles, preview/full-view controls, tool rules and synthetic inspection entries do not apply to these output items; their full supplied content remains accessible through Transcript UI disclosure and Pi's media handling. Actual tool calls retain their selected renderers and inspection behavior.

Only the generated Call/activity/group/Script output headings receive the codemode indentation. Expanded bodies receive no extra hierarchy inset; horizontal output padding, source indentation and JSON structural indentation remain. Choose **Display → Codemode → Independent items (flat)** to remove that extra heading level; ordinary group/member indentation remains present.

Call expansion preserves the selected renderer's complete call component, which can include a title, argument preview, source controls or result-dependent information. Its internal controls and code defaults are independent of the outer fold; Transcript UI does not force them open or add another code visibility setting. Ordinary tools and nested activity do not acquire a Call wrapper.

Detailed child bodies require a start and terminal result observed in the current UI session, with an unambiguous match for the parent, tool name and actual call ID. Until then, opening an activity shows its recorded preview/status, not a reconstructed result. Saved history, cancelled placeholders, ambiguous active parents and reused completed parent IDs can therefore remain metadata-only. Identical previews are not used to match calls. Rich bodies are created only for completed calls and retain the whole selected native call/result rendering, including call-slot diffs and native images.

Independent Codemode activity and Script output bodies omit the native card's extra leading separator below their headings. Renderer-owned blank lines and padding remain intact. Ordinary tool bodies and Original mode keep their native card layout.

Final-result replacements update the activities, outcome and Script output. Removed or renamed children lose their detailed bodies; later reappearance does not restore discarded results. Surviving calls keep their renderer state even when reordered. Final-message hook changes are reconciled after Pi records the message, without reopening execution capture.

Summaries do not require a detailed child body. They use matched live input first, then arguments retained for that same saved parent and child ID/name. If retained arguments were omitted, a native JSON argument preview can supply complete values before its truncation point; unfinished strings are never completed into paths. Conflicting or invalid retained arguments are not repaired from an older preview. Unrecognized request contracts keep an opaque preview.

Without a result, a read can show `Read file.ts (requested lines 10–20)` and a compatible write can show `Write file.ts (requested 3 lines)`. These describe submitted input, not returned lines or applied changes, and are not added to measured group totals. Supplied read results retain their measured count, `(lines unknown)` or error indication. Historical custom request interpretation uses the declaration at the parent occurrence when available, not today's registry; it does not prove which executor or post-hook arguments were used.

A finished parent does not make an unconfirmed child successful or leave it running indefinitely. Such a row uses its original tool name with `— completion unknown`; groups and the parent summary report the uncertainty separately. Recorded cancellation remains distinct. Shell-session summaries require their supported request contract: missing fields in a truncated `write_stdin` preview are not treated as empty input or a polling request. Exit facts still require a supplied result.

Items follow Pi's recorded order, not inferred script or completion order. Output contains the script's supplied final content after its activity; it is not interleaved with guessed printing times. Equal child-return and script-output text is retained in both places. The native protocol header is omitted only when it is the exact separate first header block. Other text, errors, truncation notices and images are retained. Full-output files are not read automatically.

Choose **Display → Codemode → Original** to keep the aggregate parent and its whole selected renderer, bypassing Script output formatting. Detected projection failures also return only that affected parent to original rendering, without resetting its code choice or disabling unrelated tools. Its existing outer disclosure flag is retained, so the original row may need to be expanded again. Opaque codemode overrides that combine or duplicate parent call/result content are not automatically certified for independent items; Original preserves their complete presentation.

When either independent-item layout is selected, a row ending in ` (original)` is using the original view because items are unavailable or a projection failed. For example, a saved codemode call may use this view when the codemode tool is not registered in the current session. The marker describes presentation availability, not execution failure. Explicitly choosing Original mode does not add it.

The execution summary describes recorded activity; Original mode retains its aggregate summary:

```text
Code…
Running code read ×2 (2 nested calls so far; 1 running)…
Ran code read ×2, bash (3 nested calls) (1.2s)
Ran code read, bash (2 nested calls; 1 error) (1.2s)
Ran code read, bash — error (2 nested calls; 1 error) (1.2s)
Ran code (0 nested calls) (0.4s)
```

`×2` counts records with the same name. Up to three names are previewed; `…` can hide additional names, but the total still counts every recorded call. Names are not an execution-order diagram. Nested calls can include model operations such as `models.classify`, not just tools. They do not establish which files changed or how many edits were applied.

While running, `so far` describes the current snapshot, not a planned total. Nested `error` and `cancelled` counts remain separate from the parent's `— error`: a script may catch a child error and finish successfully. Time follows the common [tool duration](#tool-duration) setting and describes the parent, not a sum of child durations.

Missing or unusable call records omit the nested aggregate; they do not become zero. A recorded empty list shows `0 nested calls`. Codemode summaries do not show output-line totals; a group containing codemode also omits the group-wide output-line total. Codemode is standalone by default; explicit grouping settings still apply, and groups count native parents rather than their nested calls.

This support uses Pi's native code-request, activity-metadata and renderer contracts, not the tool name alone. It does not add codemode to older hosts or decompose arbitrary batch/converter tools. The script is not parsed to predict calls or rewritten to add purpose text. Missing child bodies and historical live observations are not restored. Execution, permissions and session records remain Pi's own. See the [codemode setting](settings.md#codemode).

### Failures and unavailable counts

`— error` marks an individual failure; `— N failed` marks failures in a group. Failure status and partial measurement are separate: a successful call may still have no usable count.

A known zero is shown as zero. An unavailable count is omitted or marked unknown. On narrow screens, some labels or totals may be clipped; expand the tool to inspect the original result.

Bash summaries do not show output-line totals.

## Tool duration

Completed individual tool summaries show recorded execution time by default, after other metrics and before purpose text:

```text
Read src/config.ts (12 lines) (0.1s)
Ran npm test (exit 0) (2m 5s) — Verify changes
Ran code read ×2 (2 nested calls) (1.2s)
```

Time comes from Pi's recorded final `durationMs`, available for top-level calls from Pi 1.1.0. Codemode activities use their observed terminal duration, or their supplied recorded duration when only metadata is available. Missing or unusable values, partial results and older saved calls without timing omit it; they do not imply zero. A recorded zero displays as `0.0s`. There is no separate live clock or fallback to provider receipt text. Shell-session time describes that `exec_command` or `write_stdin` invocation, not the lifetime of the process it may leave running. Groups do not sum member times, which can overlap.

Turn **Display → Tool duration** off to hide time on every individual summary, including codemode. The whole timing token is omitted if it cannot fit within the row's fixed content and width limit. The setting does not suppress timing supplied by the original expanded renderer. See the [setting](settings.md#tool-duration).

## Command previews

In **Compact** mode, long or multiline Bash commands and recognized zsh requests can keep several command names and separators visible instead of spending all the space on the first command's arguments. Simple newline-separated commands use `↵`; newlines after `&&`, `||` or `|` retain that operator, and backslash-newline continuations outside single quotes do not create another command.

For example, three lines containing `set -euo pipefail`, `npm test` and `git diff --check` can appear as:

```text
Ran set -euo pipefail ↵ npm test ↵ git diff --check
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

Compact Bash previews use Pi's syntax colors from the original command; generated markers use the theme's muted color. Coloring is best effort: retained text with verified original-source positions keeps its syntax colors, while opaque regions remain plain. Oversized or control-bearing commands and unsupported highlighting output can still leave the whole preview uncolored. Failed rows keep their error color. Zsh, Raw and PowerShell previews do not apply shell syntax colors.

Confirmed heredocs are omitted locally, so their surrounding commands remain visible. For example:

```bash
cd foo && python <<'PY' | grep -i "bar"
print("bar")
PY
git status
```

With enough space, the preview is:

```text
Ran cd foo && python […] | grep -i "bar" ↵ git status
```

Compact recognizes `<<` and `<<-` after a command name, with nonempty delimiter names made of letters `A–Z`/`a–z`, digits, `_`, `.`, `+` or `-`, either bare or entirely single- or double-quoted. Multiple heredocs are consumed in declaration order. Closing delimiters must occupy a whole logical line; `<<-` permits leading tabs, not spaces. For unquoted delimiters, backslash-newline continuations are joined before checking the closing delimiter. Body text and closing delimiters never count as outer commands. The preview does not evaluate body expansions.

Compact does not fully parse shell scripts. Here-strings (`<<<`), heredocs inside command substitutions, redirections before the command name, output-redirection forms such as `>|` and `>>|`, other delimiter spellings, quoted newlines and other unsupported syntax remain out of scope. These cases, or an unconfirmed heredoc boundary, retain earlier recognized commands followed by one opaque remainder such as `python […]`; scanning does not resume beyond that remainder. This conservative boundary avoids presenting body text as commands. Unsupported initial single-line syntax and commands too large to compact use a first-line preview; multiline fallback also marks omitted content with `[…]`.

Zsh supports common chains, quotes, continuations and the bounded heredocs above, not the full language or runtime alias/option expansion. When shortening, zsh-specific control forms such as `repeat` and `foreach`, and modifiers such as `noglob` and `nocorrect`, keep one opaque remainder rather than displaying their bodies as separate commands. For example, a recognized `npm test` followed by a multiline `repeat` loop can appear as `Ran npm test ↵ repeat […]`. Zsh is not passed through the Bash syntax-color path.

Raw and PowerShell previews show the first line without interpreting its syntax. If later lines contain non-whitespace source, `[…]` indicates omission when space permits; trailing blank or whitespace-only lines do not add it. CRLF separators do not appear as extra spaces. The marker itself may be clipped at very narrow widths. PowerShell always uses this form.

Choose **Raw** in [command preview settings](settings.md#command-preview) to bypass compact transformations. Both modes obey the row and field width limits; neither changes execution or expanded output.
