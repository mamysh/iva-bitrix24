import { richText } from "./employee-presentation.ts";

/** The host renders this reply and turns the owner's callback into a model turn.
 * No Telegram credentials or other plugin's socket is involved. */
export function employeeChatCard(summary: string, token: string, expiresAt: number) {
  const confirmReply = `b24e:ok:${token}`;
  const cancelReply = `b24e:no:${token}`;
  return {
    markdown: [
      "**Подтверждение действия с сотрудником**",
      richText(summary),
      "Проверьте данные. Подтверждение принимает заявку в обработку; итог проверяется отдельно.",
      `<tg-button-row><tg-button type="callback_data" style="success" data="${confirmReply}">Подтвердить</tg-button><tg-button type="callback_data" style="danger" data="${cancelReply}">Отменить</tg-button></tg-button-row>`,
    ].join("\n\n"),
    confirmReply,
    cancelReply,
    expiresAt,
  };
}
