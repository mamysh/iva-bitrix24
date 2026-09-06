# Compatibility

Compatibility is claimed only for combinations that are exercised by automated checks or an
explicit live smoke test.

| Component | Version or mode | Evidence | Status |
| --- | --- | --- | --- |
| Iva | 0.3.34 | historical MCP lifecycle without the current native button flow | legacy; current button flow not supported |
| Iva | 0.4.0 | native Telegram HITL, plugin lifecycle, `iva doctor` and MCP proxy | supported |
| Node.js | 24 | CI typecheck, tests, build and stdio MCP smoke test | supported for development |
| Bitrix24 Tasks REST | current task, comment, checklist and attachment APIs | official contract review and synthetic contract tests | supported for documented read-only tools |
| Bitrix24 new task card | module `tasks 25.700.0+` discussion model | `CHAT_ID` discovery plus official `im.dialog.messages.get` contract | release candidate; live canary pending |
| Bitrix24 REST 3.0 | `/rest/api/...` | no general runtime adapter in this version | not supported; not required for the new-card discussion adapter |

The plugin uses an explicit allowlist across Tasks, IM, workgroups, users, departments and
Drive. The new-card discussion adapter uses the `CHAT_ID` exposed by established
`tasks.task.get`, then reads the linked chat with `im.dialog.messages.get`. It does not switch
the general task contract to `/rest/api/`; REST 3.0 has a different URL, field and pagination
contract and is not selected automatically.

New Iva or Bitrix24 releases are not considered supported merely because the plugin starts.
Before updating this matrix, run the full project check and the relevant clean-install,
upgrade, rollback and live read smoke tests.
