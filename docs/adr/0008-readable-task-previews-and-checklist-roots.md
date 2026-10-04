# Readable task previews and named checklist roots

Status: accepted for prerelease 0.7.0-rc.5; not live verified.

Native question prompts are literal text. The plugin groups related fields with single line
breaks, shows account email where permitted, displays wall-clock deadlines with their original
offset, and resolves checklist edits to snapshot titles. Identical titles retain identifiers.
The frozen payload, snapshot comparison and single batch approval remain unchanged.

Bitrix creates an automatic checklist name when children are added without a root. The plugin
creates an explicit named root (`PARENT_ID: 0`), validates and persists its returned ID, then
adds children under that ID. Creation defaults to “Чек-лист”; a supplied checklistTitle names
a new list. Updates preserve the sole existing root or require checklistId when several exist.
A missing root ID is an unknown write, never a reason to recreate the list. Progress separates
the heading from completed child items. Existing technical names are only renamed on request.

Rich reports remain a host-rendered skill contract. Rich native confirmations require a
supported host-channel change; adding Markdown or model-authored callbacks is not a substitute.

Reference: [Bitrix checklist add](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-add.html).
