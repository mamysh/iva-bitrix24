# Compatibility

Compatibility is claimed only for combinations that are exercised by automated checks or an
explicit live smoke test.

| Component | Version or mode | Evidence | Status |
| --- | --- | --- | --- |
| Iva | 0.3.34 | historical MCP lifecycle without the current native button flow | legacy; current button flow not supported |
| Iva | 0.4.0 | native Telegram HITL, plugin lifecycle, `iva doctor` and MCP proxy | supported |
| Iva | current upstream stable used by owner; exact installed version not recorded | owner reported successful task creation and completion on 2026-10-04 | live evidence limited to these two actions; not a full compatibility certification |
| Node.js | 24 | CI typecheck, tests, build and stdio MCP smoke test | supported for development |
| Bitrix24 Tasks REST | current task, comment, checklist and attachment APIs | official contract review and synthetic contract tests | supported for documented read-only tools |
| Bitrix24 new task card | module `tasks 25.700.0+` discussion model | `CHAT_ID` discovery, official `im.dialog.messages.get` contract, synthetic system-event test and owner live canary | supported for bounded discussion and change-event reading |
| Bitrix24 task documents | current task/chat/comment/checklist file APIs | official contracts and synthetic list, search and download tests | supported contract; live file transfer pending |
| Bitrix24 task writes | 0.6.0: established Tasks REST plus IM v2 upload | synthetic tests; owner reported live creation and completion on 2026-10-04 | stable; other write/upload live scenarios not separately verified |
| Iva file delivery plugin | existing `iva-file-delivery` MCP tools | checked local plugin contract and 50 MiB/path limits | required for Telegram document delivery |
| PDF and Office rendering | `pdftoppm`, plus LibreOffice for Office files | PDF binary available in development; Office renderer not present there | optional server dependencies; Office visual rendering pending live check |
| Bitrix24 REST 3.0 | `/rest/api/...` | official docs review at `b24restdocs@de91707`; task list filtering is documented only for `id` | evaluated and deliberately not selected for the current read contract |

The plugin uses an explicit allowlist across Tasks, IM, workgroups, users, departments and
Drive. The new-card discussion adapter uses the `CHAT_ID` exposed by established
`tasks.task.get`, then reads the linked chat with `im.dialog.messages.get`. It does not switch
the general task contract to `/rest/api/`; REST 3.0 has a different URL, field and pagination
contract and is not selected automatically. The adapter decision is recorded in
[ADR-0006](adr/0006-rest-v3-adapter-boundary.md).

New Iva or Bitrix24 releases are not considered supported merely because the plugin starts.
Before updating this matrix, run the full project check and the relevant clean-install,
upgrade, rollback and live read smoke tests.

## Форматирование и превью

Предварительная версия 0.7.0-rc.1 направляет отчёты через встроенный навык Iva rich-replies.
На клиентах без поддержки rich применяется текстовое представление Ивы. Плагин
не отправляет Telegram-сообщения самостоятельно. Обновление native ask_question после
выбора реализуется отдельно в Telegram-канале Ивы; опубликованная 0.4.11 ещё оставляет
превью с кнопками. Статус выбора не заменяет проверку результата операции.

Предварительная 0.7.0-rc.1: update существующей карточки/чек-листа, общий batch и восстановление
каталога вложений проверены синтетически. Новый сценарий на живом портале не выполнялся.
Отчёт владельца за 4 октября подтвердил комментарий и создание чек-листа в прежней версии,
но показал отсутствие редактирования, ошибку конфигурации загрузки и отдельные подтверждения.
Новая реализация устраняет эти причины; совместимость IM v2 upload с конкретным порталом
требует живой проверки после установки.
