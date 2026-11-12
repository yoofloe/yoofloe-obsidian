# Yoofloe AI 0.8.2 acceptance

Classification: prod-only. Security-sensitive: local note selection and AI context. No backend DEV/PROD, Calendar app, credential, or billing configuration changes.

## Problem and implementation plan
The reported mobile conversation had an earlier no-note response and no attached source. Opening a Markdown file only offered a new-task action because the old binding guard rejected existing answers and drafts. Reproduce that state, separate first-note connection from conversation reset, preserve existing permission choices, and provide an expanded settings view with a return action and Stop.

The final behavior connects the first user-opened allowed note without clearing existing work. A different note stays pending behind Use opened note or the header note picker. Generic Open preserves an existing note or explicit Chat without a note. Startup only registers actions; it does not attach or persist a note. Running/paused tasks keep their captured source, and pending notes remain an explicit choice after completion. A missing saved note remains identifiable and blocks dispatch. An unreadable work record disables writes to that record; separate archive/history errors preserve editable restored drafts. A first note defaults to its parent only if no folder was chosen; existing saved and explicit root choices remain unchanged.

Settings expansion reuses the same controls, preserves the draft and conversation position, displays action feedback, and exposes Stop while running. In extremely short keyboard layouts, the chat's secondary controls collapse to keep Send/Stop tappable. The Selected text indicator reflects the effective read scope.

## Verification
- Type check, lint, production build and 195 tests: 186 pass, 9 intentionally dormant skips, 0 failures.
- Offline plugin-event harness: layout restoration does not attach/write; generic Open preserves explicit no-note mode; navigation during initialization still reveals the workspace.
- Physical Android SM-M135F: real file-open events, first-note connection, explicit switching, local picker, initial preview and mocked request payload, expanded settings/feedback, keyboard editing, Stop and preserved returned response. Zero actual plugin provider calls.
- 320/384 px wide, 115–340 px tall keyboard layout fixtures in the real Android WebView: center hit test selects the 40 px primary action; secondary banner/settings bar are hidden.
- Windows installed plugin: saved chat, editor buffers, model, scope and opaque settings/key file preserved. Expanded layouts at widths 320, 768, 1024 and 1440 have no horizontal overflow.
- Local data and payload backups remain outside Git in the task evidence directory. Synthetic Android test notes remain in the dedicated test vault; originals are not deleted.

## Review and limits
Initial sealed security diff scan 02b1fd28-1598-4d5d-8fd6-6fabb7424efd covered the first 12-file candidate and reported no findings. It is immutable and does not represent the final corrected release. Subsequent CLI review found source-state, preview, scope and layout regressions; focused fixes and regression proofs above supersede the candidate's acceptance. The final CLI review and release/readback receipts are retained with the task evidence.

This is not a live-provider response-quality test, iOS test, physical tablet test, or repository-wide security assurance. Existing key material was never displayed. Historical cloud/MCP payloads and Gemini remain dormant.

## Recovery and delivery
Restore the previous three plugin payload files together if rollback is required; retain data.json, workspace.json, Markdown, history and keys. The public payload must match a clean release build byte-for-byte. The canonical plugin source receives only the focused patch; its unrelated owner-authored legacy files and root stylesheet are preserved. Installed Windows and Android plugins receive the complete matched payload.
