# iva-bitrix24

Read-only интеграция задач Bitrix24 для [Iva](https://github.com/smixs/iva-agent),
работающая как изолированный stdio MCP-плагин.

[![CI](https://github.com/mamysh/iva-bitrix24/actions/workflows/ci.yml/badge.svg)](https://github.com/mamysh/iva-bitrix24/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Iva](https://img.shields.io/badge/Iva-0.3.34%2B-6f42c1)](https://github.com/smixs/iva-agent)
[![MCP](https://img.shields.io/badge/MCP-read--only-0a7f5a)](https://modelcontextprotocol.io/)

Плагин позволяет Иве проверять подключение, находить доступные задачи, читать одну задачу,
просматривать ограниченную историю изменений и получать безопасные метаданные полей.
Он не предоставляет произвольный доступ к REST API и не умеет создавать, изменять,
закрывать или удалять задачи.

> Проект не является официальным продуктом Bitrix24 и не аффилирован с Bitrix24.

## Возможности

| MCP-инструмент | Назначение |
| --- | --- |
| `bitrix24_connection_check` | Проверить webhook минимальным вызовом `profile` |
| `bitrix24_list_tasks` | Получить ограниченную страницу задач с безопасными фильтрами |
| `bitrix24_get_task` | Прочитать одну доступную задачу по числовому ID |
| `bitrix24_task_history` | Прочитать ограниченную страницу истории изменений |
| `bitrix24_task_fields` | Получить метаданные полей без значений задач |

## Граница безопасности

- REST-методы выбирает код плагина, а не модель.
- Разрешены только `profile`, `tasks.task.list`, `tasks.task.get`,
  `tasks.task.history.list` и `tasks.task.getFields`.
- Webhook хранится в отдельном env-файле установленного плагина и не передаётся через MCP.
- Запросы выполняются только по HTTPS, без редиректов, с таймаутом и ограниченным retry.
- Ответы нормализуются: лишние поля и сырые ответы Bitrix24 наружу не передаются.
- Списки, история, строки и тело ответа имеют жёсткие лимиты.

Плагин остаётся read-only только в пределах выданных ему инструментов. Дополнительно создайте
для webhook отдельного пользователя Bitrix24 с минимальными правами и scope `task`.

## Требования

- [Iva](https://github.com/smixs/iva-agent) `0.3.34` или новее;
- Node.js 24 или новее для разработки;
- входящий webhook Bitrix24 со scope `task`;
- Linux для штатного systemd-жизненного цикла MCP-плагина в Iva.

Совместимость проверена с Iva `0.3.34` и `0.4.0`. Поддержка более новых выпусков не
подразумевается автоматически и подтверждается тестированием.

## Установка

На сервере, где уже работает Iva, выполните одну команду под пользователем Iva:

```bash
curl -fsSL https://raw.githubusercontent.com/mamysh/iva-bitrix24/main/install.sh | bash
```

Русскоязычный мастер установит плагин через штатный CLI Iva, объяснит, как подготовить
входящий webhook Bitrix24, примет его скрытым вводом через терминал, проверит доступ к профилю
и задачам и только после подтверждения запустит MCP-процесс. В конце мастер подскажет точную
фразу для продолжения настройки с Ивой в Telegram.

Установить плагин без мастера можно напрямую через официальный plugin flow Iva:

```bash
iva plugin add mamysh/iva-bitrix24/plugin
```

Не вставляйте webhook в командную строку, Telegram, issue или лог. Подробности, прозрачный
ручной fallback, первый тест, ротация и удаление описаны в [docs/SETUP.md](docs/SETUP.md).

## Разработка

```bash
npm ci
npm run check
```

`npm run check` выполняет проверку секретов, typecheck, тесты, воспроизводимую сборку bundle
и MCP smoke-test. `plugin/server.mjs` коммитится намеренно: при установке Iva не должна
загружать npm-зависимости MCP-сервера.

Принципы устройства описаны в [docs/DESIGN.md](docs/DESIGN.md), принятые архитектурные
решения — в [docs/adr](docs/adr). Изменения приветствуются по правилам
[CONTRIBUTING.md](CONTRIBUTING.md).

## Связанные проекты

- [Iva — официальный репозиторий Шимы](https://github.com/smixs/iva-agent)
- [Iva — fork mamysh](https://github.com/mamysh/iva)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## Безопасность

Не публикуйте webhook, ответы частного портала или данные задач. Уязвимости следует
сообщать приватно по инструкции в [SECURITY.md](SECURITY.md).

## Лицензия

[MIT](LICENSE) © 2026 [mamysh](https://github.com/mamysh)
