#!/usr/bin/env bash
set -Eeuo pipefail

PLUGIN_NAME="bitrix24-read"
PLUGIN_SOURCE="${IVA_BITRIX24_SOURCE:-mamysh/iva-bitrix24/plugin}"
TTY_DEVICE=/dev/tty
ROLLBACK_PENDING=0
HAD_ENV=0
ENV_FILE=""
BACKUP_FILE=""

green='\033[0;32m'
yellow='\033[0;33m'
red='\033[0;31m'
bold='\033[1m'
reset='\033[0m'

say() { printf '%b\n' "$*" >&3; }
ok() { say "${green}✓${reset} $*"; }
warn() { say "${yellow}!${reset} $*"; }
die() { say "${red}✗${reset} $*"; exit 1; }

rollback_config() {
  if [[ "$ROLLBACK_PENDING" != 1 || -z "$ENV_FILE" ]]; then return; fi
  if [[ "$HAD_ENV" == 1 && -f "$BACKUP_FILE" ]]; then
    install -m 600 "$BACKUP_FILE" "$ENV_FILE" 2>/dev/null || true
  else
    rm -f -- "$ENV_FILE" 2>/dev/null || true
  fi
  rm -f -- "$BACKUP_FILE" 2>/dev/null || true
}

on_exit() {
  local status=$?
  rollback_config
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

[[ -r "$TTY_DEVICE" && -w "$TTY_DEVICE" ]] || {
  printf '%s\n' "Для установки нужен интерактивный терминал. Подключитесь к серверу Iva по SSH и повторите команду." >&2
  exit 1
}
exec 3<>"$TTY_DEVICE"

say "${bold}Установка Bitrix24-плагина для Iva${reset}"
say ""
say "Установщик добавит read-only плагин, проверит входящий webhook и запустит его через штатные команды Iva."
say "Webhook вводится скрыто и не попадёт в историю команд или чат."
say ""

if [[ "${EUID:-$(id -u)}" == 0 ]]; then
  die "Не запускайте установщик от root. Войдите под тем пользователем, от которого установлена Iva."
fi

IVA_COMMAND="$(command -v iva || true)"
[[ -n "$IVA_COMMAND" && -f "$IVA_COMMAND" ]] || die "Команда iva не найдена. Сначала установите и запустите Iva."

NODE_COMMAND="$(command -v node || true)"
if [[ -z "$NODE_COMMAND" ]]; then
  NODE_COMMAND="$(sed -n 's/^exec "\([^"]*\)" .*$/\1/p' "$IVA_COMMAND" | tail -n 1)"
fi
[[ -n "$NODE_COMMAND" && -x "$NODE_COMMAND" ]] || die "Не найден Node.js, которым запущена Iva."

IVA_DATA_DIR="${IVA_BITRIX24_DATA_DIR:-}"
if [[ -z "$IVA_DATA_DIR" ]]; then
  IVA_DATA_DIR="$("$NODE_COMMAND" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const source = readFileSync(process.argv[1], "utf8");
    const match = /^IVA_DATA="((?:\\.|[^"])*)"$/mu.exec(source);
    if (!match) process.exit(2);
    const value = match[1].replace(/\\(["\\$`])/gu, "$1");
    if (!value.startsWith("/") || /[\0\r\n]/u.test(value)) process.exit(3);
    process.stdout.write(value);
  ' "$IVA_COMMAND")" || die "Не удалось определить каталог данных Iva. Обновите Iva и повторите установку."
fi

PLUGINS_STATE="$IVA_DATA_DIR/custom/plugins.json"
PLUGIN_DIR="$IVA_DATA_DIR/custom/plugins/$PLUGIN_NAME"
ENV_FILE="$IVA_DATA_DIR/custom/plugins/$PLUGIN_NAME.env"
BACKUP_FILE="$IVA_DATA_DIR/custom/plugins/.$PLUGIN_NAME.env.backup-$$"
[[ "$IVA_DATA_DIR" == /* && "$IVA_DATA_DIR" != *$'\n'* ]] || die "Каталог данных Iva должен быть абсолютным безопасным путём."

say "${bold}Шаг 1 из 4. Установка плагина${reset}"
if "$NODE_COMMAND" --input-type=module -e '
  import { readFileSync } from "node:fs";
  try {
    const state = JSON.parse(readFileSync(process.argv[1], "utf8"));
    process.exit(Array.isArray(state.plugins) && state.plugins.some((item) => item?.name === process.argv[2]) ? 0 : 1);
  } catch { process.exit(1); }
' "$PLUGINS_STATE" "$PLUGIN_NAME"
then
  ok "Плагин уже установлен; существующая версия сохранена."
else
  say "Источник: https://github.com/mamysh/iva-bitrix24 (папка plugin/)"
  "$IVA_COMMAND" plugin add "$PLUGIN_SOURCE" </dev/null || die "Iva не смогла установить плагин. Исправьте ошибку выше и повторите команду."
fi

SETUP_PROGRAM="$PLUGIN_DIR/setup.mjs"
if [[ ! -f "$SETUP_PROGRAM" ]]; then
  warn "В установленной версии ещё нет мастера; пробую штатное обновление плагина."
  "$IVA_COMMAND" plugin update "$PLUGIN_NAME" </dev/null || die "Не удалось обновить плагин. Выполните iva plugin sync и повторите установку."
fi
[[ -f "$SETUP_PROGRAM" ]] || die "В установленном плагине нет мастера настройки. Обновите источник и повторите установку."

say ""
say "${bold}Шаг 2 из 4. Подготовка Bitrix24${reset}"
say "1. В Bitrix24 создайте отдельного пользователя интеграции или выберите пользователя с минимальными правами."
say "2. Откройте: Приложения → Ресурсы разработчика (Developer resources)."
say "3. Откройте: Готовые сценарии (Common use cases) → Другое (Other) → Входящий webhook."
say "4. На шаге Права доступа (Assign permissions) добавьте только Задачи — scope task."
say "   Scope разрешает REST-методы задач, а видимые задачи и допустимые действия определяются правами пользователя webhook."
say "   Администраторские права не нужны и не рекомендуются."
say "5. Скопируйте полный URL вида https://ваш-портал/rest/ID/СЕКРЕТ."
say ""
say "Не отправляйте этот URL Иве в Telegram: он даёт доступ к задачам от имени пользователя webhook."
say "Официальная инструкция: https://helpdesk.bitrix24.com/open/21133100/"
read -r -p "Когда webhook готов, нажмите Enter. Для отмены нажмите Ctrl-C. " <&3

if [[ -f "$ENV_FILE" ]]; then
  HAD_ENV=1
  install -m 600 "$ENV_FILE" "$BACKUP_FILE"
  prompt="Вставьте новый webhook или нажмите Enter, чтобы проверить сохранённый: "
else
  prompt="Вставьте полный webhook Bitrix24: "
fi
ROLLBACK_PENDING=1

say ""
say "${bold}Шаг 3 из 4. Безопасная настройка${reset}"
IFS= read -r -s -p "$prompt" WEBHOOK_VALUE <&3
say ""
if ! printf '%s\n' "$WEBHOOK_VALUE" | "$NODE_COMMAND" "$SETUP_PROGRAM" "$ENV_FILE"; then
  unset WEBHOOK_VALUE
  die "Конфигурация не изменена. Исправьте проблему и снова запустите эту же команду."
fi
unset WEBHOOK_VALUE

say ""
say "${bold}Шаг 4 из 4. Запуск и проверка${reset}"
say "Iva запустит изолированный MCP-процесс плагина. Он получит только собственный env, PLUGIN_ROOT и PLUGIN_DATA."
read -r -p "Разрешить запуск плагина? [y/N] " TRUST_ANSWER <&3
case "$TRUST_ANSWER" in
  y|Y|yes|YES|Yes|д|Д|да|ДА|Да)
    "$IVA_COMMAND" plugin trust "$PLUGIN_NAME" || die "Iva не смогла запустить плагин; прежняя конфигурация восстановлена."
    ;;
  *)
    warn "Плагин настроен, но оставлен untrusted и пока не может обращаться к Bitrix24."
    warn "Для запуска позже выполните: iva plugin trust $PLUGIN_NAME"
    ROLLBACK_PENDING=0
    rm -f -- "$BACKUP_FILE"
    exit 0
    ;;
esac

ROLLBACK_PENDING=0
rm -f -- "$BACKUP_FILE"

if "$IVA_COMMAND" doctor; then
  ok "Диагностика Iva завершена."
else
  warn "Плагин запущен, но iva doctor нашёл проблему. Посмотрите сообщения выше."
fi

say ""
say "${green}${bold}Готово.${reset} Вернитесь в Telegram к Иве и отправьте ей:"
say ""
say "  ${bold}Проверь подключение к Bitrix24${reset}"
say ""
say "Ива проверит соединение через MCP и предложит первый безопасный запрос к задачам."
