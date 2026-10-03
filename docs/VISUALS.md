# Визуальный стиль и промпты

[← О плагине](../README.md) · [Вся помощь](README.md)

## Назначение

Продолжаем оформление [плагина доставки файлов](https://github.com/mamysh/iva-file-delivery)
и подачу [Ивы Шимы](https://github.com/smixs/iva-agent): сначала понятная польза и запросы
человека, затем установка и помощь. Список MCP-инструментов вынесен в отдельный справочник.

Core look: рабочие задачи доступны через спокойный разговор с Ивой.
Material language: натуральные листья, матовые тёмные карточки, тонкие светлые линии.
Structural rule: один сюжет на картинку; обложка знакомит, схема объясняет выбор после превью.
Color direction: фон `#080B0A`, текст `#F3F5EF`, мята `#91C9AD`,
голубой `#95BFDA`, коралл `#E8A88D`.

## Изображения

| Файл | Размер публикации | Размещение | Содержание |
| --- | --- | --- | --- |
| `assets/bitrix24-hero.webp` | 1792×768, 7:3 | Верх README, ширина 100% | Ветка ивы, разговор, карточки задач, календаря и документа; «Задачи ближе». |
| `assets/bitrix24-confirmation.webp` | 1792×1024, 7:4 | Раздел о действиях, ширина 100% | Запрос → превью → выбор подтверждения или отмены. |

Подписи крупные; инструкции и примеры остаются копируемым Markdown.
Обе картинки имеют alt-текст. Это иллюстрации сценариев, не скриншоты Telegram или Bitrix24.
Версии, настоящие имена, данные портала и обещания независимой серверной авторизации
на изображениях отсутствуют. Для следующих картинок сохраняйте палитру и один простой сюжет.

## Генерация

Промпты подготовлены через навык **image**, по структуре GPT Image.
Ниже рекомендуемые параметры для повторной генерации. Использован встроенный **imagegen**:
он выбирает модель сам и не раскрывает параметр quality, поэтому фактическая модель не заявляется.
Исходные PNG сохранены генератором; в репозитории опубликованы оптимизированные WebP.

### Обложка

- Model: gpt-image-2.5-flare
- Quality: high
- Size / Ratio: 1792×768 / 7:3

Prompt:

```text
Create a wide editorial cover illustration, 1792x768 pixels, for the independent Iva Bitrix24 task integration GitHub repository.
Scene: opaque near-black #080B0A background with subtle fine grain and spacious composition.
Subject: a delicate drooping willow branch with long natural leaves occupies the left third. At its base a dark speech bubble with a small mint conversation symbol connects by a thin curved line to a restrained cluster of three task cards at lower right: one with a checklist, one with a calendar symbol, one with a document and a small coral comment mark.
Important Details: in the upper center and right render exactly once the small spaced label "IVA / BITRIX24"; render exactly once the large Russian heading "Задачи ближе" on two lines, "Задачи" then "ближе". Ivory #F3F5EF geometric sans serif, large readable Cyrillic, generous spacing. Task cards use mint #91C9AD, blue #95BFDA, coral #E8A88D pictograms, matte charcoal translucent surfaces, fine softly lit edges. Natural botanical leaf texture and calm composition. Only abstract horizontal strokes inside task cards, no small text.
Use Case: GitHub README cover viewed at 850px wide, communicating work tasks available through a conversation with Iva. Original sibling artwork to a botanical file-delivery plugin cover.
Constraints: exact text only, no extra words, no duplicate text, no watermark, no version numbers, no official Bitrix24 logos or endorsement, no real task data, no names or portal URLs. Illustration rather than a real interface screenshot. Keep the title dominant, dark negative space generous, and lighting restrained without neon bloom.
```

### Подтверждение действия

- Model: gpt-image-2.5-flare
- Quality: high
- Size / Ratio: 1792×1024 / 7:4

Prompt:

```text
Create an explanatory editorial illustration, 1792x1024 pixels landscape, for Iva Bitrix24 task actions.
Scene: opaque near-black #080B0A with fine grain and ample negative space; one small natural willow twig at upper left.
Subject: three large balanced zones in a left-to-right sequence: left a dark speech bubble with a small ivory conversation icon; center a dark task preview card with a mint checklist icon, three simple horizontal content strokes and a small blue calendar pictogram; right a dark confirmation card with exactly two clearly separated options, a mint outlined rectangular button reading "Подтвердить" and a quieter coral outlined rectangular button reading "Отменить". Thin directional mint connectors link request to preview and preview to choice.
Important Details: render exactly once the large ivory geometric sans-serif Russian labels below the respective zones: "Попросите Иву", "Проверьте превью", "Выберите действие". Render the two button labels exactly once each, large and legible. Use mint #91C9AD, blue #95BFDA, coral #E8A88D on matte charcoal surfaces with fine softly lit edges, natural botanical detail, the same calm editorial vocabulary as a willow task integration cover.
Use Case: conceptual illustration of the normal user workflow: request, review the full draft, confirm or cancel an action on a task. GitHub README viewed at 850px wide.
Constraints: exact text only, no extra lettering, no duplicate words, no task names or personal data, no dates, no checkmark suggesting execution before confirmation, no official logos, no watermark. This is a conceptual diagram, not a shipped Telegram or Bitrix24 screenshot. Show both choices equally clearly; no decorative neon or circuitry.
```

## Проверка

Точный текст, читаемая кириллица, три последовательных шага, видимые обе кнопки.
Проверяйте иллюстрации вместе с обычным текстом на странице GitHub.
При правке меняйте одну вещь за раз; сохраняйте палитру, ботанику, расположение и точные подписи.

## Атрибуция

Методика промптов: Serge Shima,
[image / visual-skills](https://github.com/smixs/visual-skills), **CC BY 4.0**.
Промпты адаптированы для `iva-bitrix24`. Изображения созданы для этого репозитория;
исходные картинки Ивы в него не включены.
