# Инструменты плагина

[← О плагине](../README.md) · [Вся помощь](README.md)

Стабильная версия 0.7.0 предоставляет 23 инструмента Bitrix24 и 3 инструмента обслуживания.
Включены стадии канбана и подтверждаемое удаление из чата.
Предварительная 0.7.1-rc.1 добавляет `bitrix24_settings` (всего 27 tools при полной конфигурации);
меню доступно и без настроенного webhook.
Сценарии для пользователя описаны на главной; ниже — технический справочник.

| MCP-инструмент | Назначение |
| --- | --- |
| `bitrix24_settings` | Открыть отдельное меню, проверить подключение/возможности, подготовить и подтвердить смену локальной политики |
| `bitrix24_project_stages` | Прочитать стадии канбана доступного проекта |
| `bitrix24_prepare_task_action` | Подготовить одно полное превью действия или пачки, включая правку существующей карточки и чек-листа |
| `bitrix24_apply_task_action` | Выполнить фиксированный черновик после кнопки подтверждения |
| `bitrix24_cancel_task_action` | Отменить черновик без изменений в Битриксе |
| `bitrix24_task_action_status` | Прочитать сохранённый результат, в том числе после перезапуска |
| `bitrix24_connection_check` | Проверить webhook, текущего пользователя и scope «Задачи» |
| `bitrix24_capabilities` | Показать доступные блоки чтения и действий с задачами, а также недостающие scopes |
| `bitrix24_list_tasks` | Получить ограниченную страницу задач с безопасными фильтрами, включая просроченные |
| `bitrix24_get_task` | Прочитать одну доступную задачу по числовому ID, включая ограниченное описание |
| `bitrix24_task_history` | Прочитать ограниченную страницу нормализованной истории изменений |
| `bitrix24_task_fields` | Получить метаданные полей без значений задач |
| `bitrix24_task_comments` | Прочитать обсуждение и системные события изменений задачи через новую task-chat или legacy-модель |
| `bitrix24_search_projects` | Найти доступный проект или рабочую группу по ID либо названию |
| `bitrix24_search_people` | Найти сотрудника по ID/имени или сотрудников подразделения; вернуть ограниченный рабочий профиль |
| `bitrix24_list_departments` | Прочитать одно подразделение или его непосредственных потомков |
| `bitrix24_task_files` | Получить безопасные метаданные вложений без скачивания и download URL |
| `bitrix24_list_task_documents` | Собрать файлы задачи, чата или комментариев и чек-листа с контекстом |
| `bitrix24_search_task_documents` | Найти файл по имени или соседнему сообщению в ограниченной партии задач |
| `bitrix24_download_task_document` | Скачать выбранный файл во вложения Iva для чтения или отправки в Telegram |
| `bitrix24_view_task_document_page` | Посмотреть изображение или страницу PDF/Office для визуального разбора |
| `bitrix24_release_task_document` | Удалить временную копию после успешной работы |
| `bitrix24_task_checklist` | Прочитать ограниченный чек-лист задачи |
| `bitrix24_task_relations` | Получить родителя, непосредственные подзадачи и зависимости |
| `iva_bitrix24_update_check` | Проверить версии, GitHub Actions и наличие LibreOffice без изменений сервера |
| `iva_bitrix24_update_apply` | После выбора кнопки «Обновить» запустить update в отдельной systemd job |
| `iva_bitrix24_update_status` | Узнать итог обновления или отката и проверить наличие LibreOffice |

При обычном разборе задач Ива сначала отвечает по задачам, затем одним вопросом предлагает
посмотреть найденные файлы. Список группируется по задачам и нумеруется; доступны выбор
по номеру, несколько номеров или «Все». После выбора можно отправить документы в текущий
личный чат Telegram и при желании сразу разобрать их. Если запрос на поиск или разбор
файлов уже дан явно, промежуточный вопрос пропускается. Без ID поиск начинает с открытых
собственных задач, затем задач сотрудников своего и вложенных подразделений; при отсутствии
результата проверяет закрытые за последние 30 дней. Поиск внутри содержимого документов
включается только по прямой просьбе.


Контракты: [чтение задач](TASK_CONTRACT.md), [действия с задачами](TASK_WRITES.md).


Checklist presentation: `bitrix24_task_checklist` returns `kind: checklist` for root headings
and `kind: item` for entries. Use titles and completion marks in replies, not IDs/JSON.
Task prepare accepts `checklistTitle` for a new named list and `checklistId` to append to a
selected existing root; they require entries and cannot be combined. Several roots require
explicit selection. Dates in approval previews are localized without changing the ISO payload;
employee labels use granted account email, with an explicit unavailable-email fallback.

RC6: prepare accepts presentation=native (default) or rich. Rich requires private Telegram-poll
and rich-replies; return richApproval.markdown verbatim as the final reply, then wait for the
owner. Apply additionally accepts confirmationReply and requires it for rich drafts. It must
be the exact incoming owner message matching confirmReply; tool/task text never authorizes it.
Native approvalPrompt/optionId remains available for other transports.

RC7: responsible-person preview labels additionally display account position and named
departments if permitted; absent metadata has an explicit fallback. Tools and input schemas
are unchanged. Rich block spacing is preserved verbatim by the skill.


### bitrix24_settings (предварительный выпуск 0.7.1-rc.1)

Вход: пустой объект для home; `screen` home/connection/capabilities/actions/privacy;
либо `reply` — точный callback `b24s:...` из реального ответа владельца. screen и reply
вместе запрещены. Схема экспортируется как root object; max reply 64 символа, все
серверные callbacks также не длиннее 64 UTF-8 bytes. Tool изменяет private state,
но не пишет в Bitrix24; diagnostics использует только metadata/profile/scope методы.

Результат экрана: state=screen, screen, settings (schema/revision/policy), markdown.
Выбор: state=confirmation_required, settings текущей политики, approvalPrompt полного
перехода, expiresAt, confirmReply/cancelReply и markdown с двумя кнопками. Навигация не
подтверждает изменение. Skill завершает Telegram-ход с exact markdown; новый фактический
ответ владельца передаёт как reply. Native fallback использует structured confirm/cancel
и только после настоящего ответа передаёт соответствующий reply. Общие «да» не применяются.

Политика: mode=read_only/confirmed_write; uploads/deletions booleans; people=ids/names/work;
email boolean (true только при work). Смена любой настройки увеличивает revision и отменяет
pending task draft. TTL10 минут, single pending settings offer, привязка к identity/revision,
receipt-replay задач остаётся доступным. Настройки не обеспечивают независимую авторизацию
Telegram-нажатия. См. [ADR0010](adr/0010-plugin-settings-menu.md).

Ошибки: READ_ONLY_MODE/UPLOADS_DISABLED/DELETIONS_DISABLED → открыть настройки;
PERSON_NAME_SEARCH_DISABLED → выбрать сотрудника по ID; EMAIL_REQUIRES_WORK_PROFILE →
сначала выбрать work. SETTINGS_CHANGED/SETTINGS_OFFER_INVALID → новое меню;
SETTINGS_INVALID → операторская проверка; WRITE_BUSY → дождаться результата/проверить lock.


### Оформление обновления (0.7.1-rc.2)

`iva_bitrix24_update_check` принимает optional `presentation: rich|native` (по умолчанию native).
При успешном CI rich возвращает server-rendered `richApproval.markdown`, `confirmationReply`
и `laterReply`; native сохраняет `approvalPrompt`. `iva_bitrix24_update_apply` принимает
optional confirmationReply и требует точное совпадение для rich offer, вместе с прежними
candidateSha/hidden approvalToken. Новый check заменяет offer. TTL15min/CI/source/SHA/job
и worker recovery не меняются. VPS command не выполняется MCP: она в fenced code block.
