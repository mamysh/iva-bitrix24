import { employeeScopes } from "./employee-directory.ts";
import type { PluginPolicy } from "./settings.ts";

const people = ["user_brief", "user_basic", "user"] as const;
const email = ["user_basic", "user"] as const;
const task = ["task"] as const;
const taskChat = [task, ["im"]] as const;
const taskWrite = [task, people] as const;
const chatWrite = [...taskWrite, ["im"]] as const;
const employeeWrite = employeeScopes.map(scope => [scope]);
const writeSettings = ["data", "write"] as const;
const employeeSettings = [...writeSettings, "employees", "work", "email"] as const;

const features = {
  checklistAndRelations: ["Задачи, чек-листы и связи", [task], []],
  taskDiscussion: ["Обсуждения в чате задачи", taskChat, []],
  projects: ["Поиск проектов", [["sonet_group"]], []],
  people: ["Поиск сотрудника по ID", [people], []],
  peopleByName: ["Поиск сотрудника по имени", [people], ["names"]],
  employeeEmail: ["Рабочий email", [email], ["work", "email"]],
  departments: ["Подразделения", [["department"]], []],
  taskFiles: ["Вложения задач", [task, ["disk"]], []],
  taskChatFiles: ["Вложения из чата задачи", taskChat, []],
  taskFileDownload: ["Скачивание вложений задачи", [task, ["disk"]], ["attachments"]],
  taskChatDownload: ["Скачивание вложений из чата", taskChat, ["attachments"]],
  taskActions: ["Создание и изменение задач", taskWrite, writeSettings],
  taskReassignment: ["Смена ответственного", taskWrite, writeSettings],
  taskChatActions: ["Комментарий в чате задачи", chatWrite, writeSettings],
  taskUpload: ["Загрузка файла в чат задачи", chatWrite, [...writeSettings, "uploads", "attachments"]],
  taskChatDeletion: ["Удаление файла или сообщения из чата", chatWrite, [...writeSettings, "deletions"]],
  employeeInvite: ["Приглашение сотрудника", employeeWrite, employeeSettings],
  employeeUpdate: ["Изменение профиля сотрудника", employeeWrite, employeeSettings],
  employeeDismiss: ["Увольнение сотрудника", employeeWrite, employeeSettings],
} as const;

export function missingWebhookScopes(id: keyof typeof features, granted: ReadonlySet<string>) {
  return features[id][1].filter(group => !group.some(scope => granted.has(scope))).map(group => group[0]!);
}

export function webhookReport(
  grantedScopes: readonly string[],
  policy: Readonly<PluginPolicy>,
  runtime: { privateData: boolean; attachments: boolean },
) {
  const granted = new Set(grantedScopes);
  const settings = {
    data: runtime.privateData ? null : "настроить приватный каталог плагина",
    write: policy.mode === "confirmed_write" ? null : "включить запись с подтверждением в «Действиях»",
    employees: policy.employees ? null : "включить управление сотрудниками в «Действиях»",
    names: policy.people === "ids" ? "разрешить имена в «Данных»" : null,
    work: policy.people === "work" ? null : "выбрать рабочий профиль в «Данных»",
    email: policy.email ? null : "разрешить email в «Данных»",
    uploads: policy.uploads ? null : "разрешить загрузку файлов в «Действиях»",
    deletions: policy.deletions ? null : "разрешить удаление в «Действиях»",
    attachments: runtime.attachments ? null : "настроить каталог вложений Ивы",
  };
  const rows = (Object.keys(features) as Array<keyof typeof features>).map(id => {
    const [label, , settingKeys] = features[id];
    return {
      id,
      label,
      missingScopes: missingWebhookScopes(id, granted),
      settingHints: settingKeys.flatMap(key => settings[key] ?? []),
      portalAccess: "not_checked" as const,
    };
  });
  const markdown = [
    "**Выданные права для Bitrix24 в Иве**",
    grantedScopes.map(scope => `\`${scope}\``).join(", ") || "Права для возможностей плагина не выданы.",
    "",
    "**Возможности Bitrix24**",
    ...rows.map(({ label, missingScopes, settingHints }) => {
      const next = [
        ...(missingScopes.length ? [`в Bitrix24 добавить ${missingScopes.map(scope => `\`${scope}\``).join(", ")}`] : []),
        ...settingHints,
      ];
      return next.length ? `○ ${label} · ${next.join(" · ")}  ` : `✓ ${label} · права и настройки есть  `;
    }),
    "",
    "Старые комментарии могут работать с правом `task` без `im`.",
    "",
    "**Доступ пользователя Bitrix24**",
    "Права на конкретные задачи, чаты, файлы и кадровые операции эта проверка не подтверждает. Для приглашений и изменения чужих профилей проверьте права владельца вебхука в Bitrix24. Запись по-прежнему требует превью и подтверждения в чате Ивы.",
    "",
    "**Где добавить права**",
    "Bitrix24 → Приложения → Ресурсы разработчика → Интеграции → ваш вебхук → Права доступа. Сохраните и проверьте снова. Если URL изменился, введите новый URL через установщик. Секрет в чат не отправляйте.",
  ].join("\n");
  return { rows, markdown, taskContentChecked: false };
}
