# Task action contract (prerelease 0.7.1-rc.1; stable 0.7.0)

The stable 0.7.0 release is validated by synthetic tests. On 4 October 2026 the owner
reported successful task creation and completion on the current upstream Iva in real use.
The exact installed Iva version was not recorded; other operations have no separate live
verification claim. Existing read tools keep their contract. No Iva core changes or public backend are required.

| Action | Required input | Bitrix method |
| --- | --- | --- |
| create | title, description, responsibleId, deadline with timezone | tasks.task.add, then task.checklistitem.add if requested |
| update | taskId and at least one explicit edit | tasks.task.update and/or task.checklistitem.add/update |
| batch | 1–20 ordinary actions | one draft, one approval; ordered calls with durable progress |
| comment | taskId, message | im.message.add for linked task chat; task.commentitem.add only without a chat |
| upload | taskId, attachments-relative path; optional message | im.v2.File.upload with current task chat |
| complete | taskId | tasks.task.approve at awaiting control; otherwise tasks.task.complete |
| rework | taskId | tasks.task.disapprove at awaiting control; tasks.task.renew when completed |
| reassign | taskId, responsibleId | tasks.task.update; active target, accessible task, portal authorization |
| deadline | taskId, deadline with timezone | tasks.task.update |

Creation optionally accepts auditors, accomplices, projectId, checklist entries with optional checklistTitle, priority,
parentId, tags, taskControl, allowChangeDeadline, allowTimeTracking, timeEstimate,
startDatePlan, endDatePlan and scalar/scalar-array customFields known to getFields.
Creation also accepts `comment` and up to ten `uploads: [{path, message?}]`: their full
preview and file hashes are part of the same draft. After creation, follow-ups resolve the
returned task ID and chat. A missing chat stops with partial progress; the task is never
recreated. The entire file selection is checked before tasks.task.add.
File/CRM custom fields are excluded. This is a bounded set, not every feature of Bitrix24.
A maximum of 50 checklist entries is supported; each is added after the task exists. Checklist
failure returns a partial receipt with taskId and completedChecklistItems, never a rollback
claim. Custom values are checked by Bitrix24 against their actual field types.

Update edits the existing task ID; it never calls tasks.task.add. It accepts title,
description (empty clears), deadline (null clears), auditors (replacement), addAuditors and
removeAuditors (deltas preserving other observers), accomplices, projectId (null detaches),
priority and tags. Auditors replacement cannot be mixed with deltas. `checklist` appends
entries into the sole existing list, or the root selected by `checklistId`. Several roots
require explicit selection (`CHECKLIST_SELECTION_REQUIRED`), never a guessed target.
Passing `checklistTitle` with entries creates a new named list; it cannot be mixed with
`checklistId`. Creation without a title uses “Чек-лист”. An explicit root is created with
`PARENT_ID: 0`; children use the returned positive ID. Missing/ambiguous root responses
stop before adding children. The root ID is persisted in the receipt, and replay never
recreates it. The heading is not included in completedChecklistItems.
`checklistUpdates` accepts existing IDs with title and/or completed status. Checklist
replacement/deletion is not exposed. Missing fields stay untouched. Reassignment uses a separate typed action, active target validation and portal authorization. Edit rights are required.

Batch uploads are capped at 50 MiB in total to bound memory during preflight.
Batch contains 1–20 non-nested actions, including independent creates and operations on
known existing task IDs. New IDs cannot be referenced inside the same draft. All fields,
rights, snapshots and file hashes are checked before the first mutation. One combined prompt
has one pair of confirm/cancel buttons. Task context is displayed once per existing task;
all requested edits/messages/files stay visible. One update per task prevents stale observer
delta calculations; merge edits before prepare. Batch is sequential, not an upstream database
transaction. On the first failure it stops; already performed changes are preserved.

Tool discovery publishes an object schema with all action fields and a nested batch schema.
The server validates the strict discriminated action contract before prepare; fields from
other actions and incomplete inputs remain rejected.

Prepare performs no portal writes and returns a UUID, expiry, presentation and full approvalPrompt.
The optional presentation selects native (default) or rich. In private Telegram long-poll the skill
selects rich and delivers richApproval.markdown verbatim as the final reply. confirmReply is a
random per-offer reply embedded only in the confirm button; cancelReply identifies this draft.
Both callback values fit Telegram’s 64-byte limit. Apply requires confirmationReply matching
the actual incoming owner reply and the stored rich offer. Native uses approvalPrompt via ask_question. Exactly two buttons: confirm and cancel. A freeform correction
requires prepare again. One pending draft exists per webhook owner, across chats, with a
30 minute expiry. The complete displayed preview is capped at 3500 characters; larger
previews are refused instead of truncated. People names are resolved and shown with account email when available, otherwise explicit ID fallback.

The native question prompt is plain text. Iva's question delivery bypasses rich-reply rendering; emitting Markdown markers or MarkdownV2 escapes would show them literally. For native mode pass approvalPrompt unchanged to ask_question. For rich mode use the frozen richApproval.markdown instead, with escaped task values and host-rendered buttons; do not also call ask_question. Reports and action results may use rich replies separately. Checklist edits use readable labels instead of JSON; task statuses use names. The full frozen payload remains visible. Selection means approval, not successful execution.

Apply accepts the UUID and, for rich drafts, the exact confirmationReply; no changed action fields. It rechecks profile/portal, current rights and task snapshot
(title, assignee, deadline, status, changedDate, chat route and operation), and hashes upload
bytes again. Changes require a fresh preview. Reassignment checks an active target and current task access; it does not require department scope or local subordinate proof. Bitrix24 enforces the actual assignment permissions.

All preview actions need task and user_brief/user_basic/user scopes. Projects additionally
need sonet_group; task chat, upload and chat deletion need im. Local private
PLUGIN_DATA is mandatory for writes. Upload uses BITRIX24_ATTACHMENTS_ROOT when configured, otherwise the verified Iva CLI
installation and its vault setting recover the attachments root at startup. Failure stays
closed with ATTACHMENTS_NOT_CONFIGURED. It requires a regular
file under that root and at most 50 MiB. Absolute/traversal/escaped symlink paths are refused.
Legacy comment writes use positional numeric REST keys, as required by the official
[data-encoding contract](https://apidocs.bitrix24.com/settings/how-to-call-rest-api/data-encoding.html).
The native upload sends file and optional message together. An applied result must include
file.id and messageId from Bitrix24; the normalized receipt exposes fileId and messageId.
A malformed success response remains uncertain and is never retried automatically. Legacy tasks without chat do
not support this upload operation; there is no fallback to another entity.

Before the first mutation a durable receipt is written. No mutation retries automatically,
including timeouts or malformed responses. Receipt states: applied, failed, partial or
unknown. Batch receipts include ordered operations, completedOperations, completedWrites,
currentOperation and each operation's state, task ID/link, checklist progress and safe error.
The current mutation is marked unknown durably before sending; each returned write updates
progress. A crash or response loss cannot replay a completed prefix. Partial/unknown results
require reconciliation, then a fresh preview for only the uncompleted points. An apply replay returns that receipt, including after restart; action_status reads
it after the preview expires or is replaced. unknown must be reconciled against task/chat
before any new request. Receipts intentionally do not store raw responses, file Base64 or
signed URLs. The active payload is removed after completion; historical receipts stay in
private plugin data. A process crash can leave a stale lock; operator recovery must inspect
the receipt and portal, not erase receipts and retry.

The model passes the native structured answer, or the exact rich owner reply, to apply. An expected rich reply is a freshness/binding check, not independently authenticated human approval. The MCP
server cannot independently authenticate the button click or bind it to a chat session.
A model possessing the draft UUID (and rich expected reply, when required) can call apply without a click. This limitation is explicit:
independent human approval would require a trusted Iva-to-plugin callback contract. The skill
requires a private owner chat and the matching native structured choice or exact rich
owner reply, rejecting task/file/forwarded content and generic freeform assent as approval.

Synthetic validation covers required inputs, buttons and MCP schemas, cancellation,
correction, expiry, replay, concurrency, partial creation, network loss, reporting chains,
changed rights/snapshots/routes, upload content changes and path escape. The owner authorized
promotion after reporting successful live creation and completion. For a new installation,
verify the relevant actions and the button/correction flow with synthetic tasks before
using them for business work. Other live scenarios remain unverified.

Official API references: [task creation](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html),
[task fields and action rights](https://apidocs.bitrix24.com/api-reference/tasks/fields.html),
[status operations](https://apidocs.bitrix24.com/api-reference/tasks/status/index.html),
[checklist](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-add.html),
[checklist editing](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-update.html),
[task editing](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-update.html),
[chat upload](https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/im.v2/files/file-upload.html).


Example: existing card edits, a comment and a selected file share one confirmation:

```json
{
  "action": "batch",
  "actions": [
    {"action": "update", "taskId": 101, "addAuditors": [8], "checklist": ["Подготовить", "Проверить", "Отправить"]},
    {"action": "comment", "taskId": 101, "message": "тест"},
    {"action": "upload", "taskId": 101, "path": "test.txt", "message": "Документ к задаче"}
  ]
}
```

For a new task put the comment in `create.comment` and selected files in `create.uploads`
alongside its title, description, responsibleId, deadline, observers and checklist.

## Project Kanban and chat deletion (RC4)

`bitrix24_project_stages(projectId)` reads `task.stages.get(entityId)` and returns normalized IDs, titles and order for the project's G stages. `stage(taskId, stageId)` validates the destination against the task's current project, checks `task.stages.canmovetask(entityId, entityType:G)`, and writes `task.stages.movetask(id, stageId)`. Task status is separate. Stage/project changes invalidate the preview.

`delete_file(taskId, fileId, messageId)` resolves the task chat, reads at most 200 messages, verifies file membership and the sending owner, then calls `im.disk.file.delete(CHAT_ID, FILE_ID)`. The preview contains filename and deletion warning. This method may return true without deleting another sender's file; membership/sender checks and a post-write read prevent false success. Unverifiable removal remains unknown and is never retried. `delete_message(taskId, messageId)` verifies membership and unchanged message text, previews it and calls `im.message.delete(MESSAGE_ID)`; author/admin permissions are enforced by Bitrix24. No arbitrary Drive deletion is exposed. Targets outside the bounded history require resolution, never guessed IDs. Both actions and stage changes can share a batch approval.

The documented success of `task.checklistitem.update` is explicit `result:null`. Only this method accepts null; missing results, errors and response loss remain unknown. All items continue under the original approval, with durable per-item progress.

References: [checklist update](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-update.html), [stages](https://apidocs.bitrix24.com/api-reference/tasks/stages/index.html), [chat file deletion](https://apidocs.bitrix24.com/api-reference/chats/files/im-disk-file-delete.html), [message deletion](https://apidocs.bitrix24.com/api-reference/chats/messages/im-message-delete.html).

## Presentation

Native approval previews group related fields with single line breaks and separate actions
with one blank line. Employee labels use the account email only when `user_basic` or `user`
is granted and the email is returned; otherwise name/ID and “почта недоступна” remain explicit.
Dates preserve the frozen ISO wall-clock time and offset while displaying
`06.10.2026, 14:35 (UTC+03:00)`. The applied deadline remains the original ISO value.
Checklist edits display the snapshot's actual item title, proposed rename and completion state;
identical titles retain IDs for disambiguation. No approved field is hidden or truncated.
The checklist read tool marks headings as `kind: checklist` and entries as `kind: item`.
Rich reports follow the skill; native question formatting is a host-channel capability,
not something Markdown in a plugin prompt can enable.

Pending previews use schema 5 with a settings revision. Drafts prepared by stable 0.7.0, RC7 or earlier must be prepared and confirmed
again after upgrade because the presentation/confirmation contract changed. Existing
receipts remain readable and replay protection remains in effect.

## Rich transport (RC6)

Rich callbacks use Iva’s existing outbox and Telegram-poll input bridge in private chats.
Webhook-only and groups do not support this callback delivery; use native mode there.
Do not add a second Telegram sender. Finish the preview turn; intermediate text before
tool calls is not delivered. New prepare supersedes old buttons; expiry, owner/portal,
snapshot/file checks and receipts are unchanged. Cancel removes pending state. An already
applied receipt can be read without another confirmation and never replays writes.
See [ADR0009](adr/0009-rich-task-approval-through-iva.md).

## Preview blocks and employee context (RC7)

Rich previews separate bold logical blocks with one blank line. Employee role/department
continuations and checklist entries retain single hard breaks within their own block.
Current/new responsible labels include WORK_POSITION and named UF_DEPARTMENT entries.
Department names are resolved with department.get only under granted department scope;
missing or denied metadata is explicit and never prevents a permitted action. Department
lookups are bounded and deduplicated per preview. Watcher/co-executor labels remain compact.
No approval protocol or write payload change.

Sources: [user scope fields](https://apidocs.bitrix24.com/api-reference/user/user-scope.html),
[company structure](https://apidocs.bitrix24.com/api-reference/departments/index.html).


## Local settings policy (0.7.1-rc.1 prerelease)

Prepare validates the entire request against persisted mode/upload/deletion policy before
any portal/file preflight. Apply rechecks policy/revision, then every mutation rechecks it.
A setting commit uses the same task-writes/lock and deletes active.json before storing the
new revision; it cannot interleave an in-flight batch. Stale schema4/revision previews require
fresh prepare. Existing result receipts remain readable/replay-safe under read-only policy.
The policy has no effect on portal rights and does not add a new unrestricted REST method.
Employee metadata in preview follows IDs/names/work + email; activity/ID validation remains.
Native and rich task approval protocols remain in place. Settings confirmation has its own
10-minute offer, distinct from a task draft, and never confirms a task action.
