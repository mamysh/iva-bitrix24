# Установка и настройка

## 1. Подготовьте Bitrix24

1. Создайте отдельного пользователя интеграции либо выберите пользователя с минимально
   необходимым доступом к задачам.
2. Ограничьте доступ только теми задачами, которые разрешено читать через Iva.
3. Создайте входящий webhook со scope `task`.
4. Не копируйте URL webhook в чат, issue, документ, командную строку или репозиторий.

Администраторские права не требуются и не рекомендуются: REST API видит задачи в пределах
прав пользователя, создавшего webhook.

## 2. Рекомендуемая установка одной командой

Требуется Iva `0.3.34` или новее. Подключитесь к серверу по SSH под тем Unix-пользователем,
которому принадлежит установка Iva, и выполните:

```bash
curl -fsSL https://raw.githubusercontent.com/mamysh/iva-bitrix24/main/install.sh | bash
```

Мастер использует `/dev/tty`, поэтому остаётся интерактивным внутри pipe. Он:

1. добавляет `mamysh/iva-bitrix24/plugin` через штатный `iva plugin add` без trust;
2. объясняет, какой входящий webhook создать;
3. принимает URL скрыто, проверяет `profile` и `tasks.task.getFields`;
4. атомарно сохраняет `data/custom/plugins/bitrix24-read.env` с правами `0600`;
5. после явного подтверждения выполняет `iva plugin trust bitrix24-read` и `iva doctor`;
6. предлагает вернуться в Telegram и написать Иве: «Проверь подключение к Bitrix24».

Не запускайте мастер от `root`: он должен работать с теми же файлами и systemd user units,
что и Iva.

## 3. Прозрачный ручной fallback

Если bootstrap недоступен, установите подпапку плагина напрямую без клонирования репозитория:

```bash
iva plugin add mamysh/iva-bitrix24/plugin
```

После добавления ожидается состояние `enabled · untrusted`. Не включайте trust до создания
env-файла. Из корня установки Iva создайте пустой файл с закрытыми правами:

```bash
install -m 600 /dev/null data/custom/plugins/bitrix24-read.env
${EDITOR:-vi} data/custom/plugins/bitrix24-read.env
```

Добавьте одну строку:

```dotenv
BITRIX24_WEBHOOK_BASE_URL=https://example.bitrix24.com/rest/USER_ID/WEBHOOK_SECRET
```

Замените пример внутри редактора и сохраните файл. Не используйте `echo` и не передавайте
webhook аргументом команды. Проверьте права:

```bash
stat -c '%a %n' data/custom/plugins/bitrix24-read.env
```

Ожидаемые права — `600`.

## 4. Разрешите запуск при ручной установке

Все команды жизненного цикла выполняйте под тем Unix-пользователем, которому принадлежит
установка Iva:

```bash
iva plugin trust bitrix24-read
iva plugin list
iva doctor
```

На Linux Iva запускает stdio MCP-сервер через собственный loopback proxy и systemd user
service. На системе без systemd состояние trust может сохраниться без автоматического запуска
процесса.

## 5. Проведите первый тест

В новом диалоге попросите Iva проверить подключение. Первый вызов должен использовать
`bitrix24_connection_check`. Затем запросите небольшую страницу собственных задач; начните со
scope `mine`, чтобы проверить границы доступа пользователя webhook.

Для локальной диагностики разработчика предусмотрен безопасный smoke-test:

```bash
npm run smoke:live -- /absolute/path/to/secrets.env
```

Файл должен иметь права `0600` и содержать `BITRIX24_WEBHOOK_BASE_URL`. Smoke-test вызывает
только allowlisted read-only методы и выводит проверки формы ответа, а не значения профиля и
задач.

## 6. Обновление и восстановление

После обновления исходников пересоберите и проверьте проект, затем синхронизируйте плагин:

```bash
npm ci
npm run check
iva plugin sync
iva doctor
```

Проверяйте release notes Iva перед обновлением. Заявленная матрица совместимости относится
только к версиям, указанным в README.

## 7. Отключение, удаление и ротация

Остановить доверенный процесс:

```bash
iva plugin untrust bitrix24-read
```

Скрыть capability из Iva:

```bash
iva plugin disable bitrix24-read
```

При удалении отдельно решите судьбу `data/custom/plugins/bitrix24-read.env` и данных из
`data/plugin-data/bitrix24-read/`: они могут переживать переустановку по политике Iva.

Если webhook попал в лог, чат, shell history или git, немедленно отзовите его в Bitrix24,
создайте новый и замените значение через редактор. Не ограничивайтесь удалением строки из
файла или commit.

## Troubleshooting

- `enabled · untrusted`: env ещё не настроен либо процесс не получил trust.
- `CONFIGURATION_ERROR`: проверьте наличие переменной, HTTPS, отсутствие query/fragment и
  канонический путь `/rest/USER_ID/WEBHOOK_SECRET`.
- `NO_AUTH_FOUND`: webhook отозван, неверен или недоступен пользователю.
- Пустой список при `scope=mine`: проверьте, назначены ли задачи пользователю webhook.
- Ошибки после обновления Iva: выполните `iva plugin sync`, затем `iva doctor`.

При публикации issue используйте только коды ошибок и синтетические примеры. Не прикладывайте
env-файл, полный URL запроса или сырой REST-ответ.
