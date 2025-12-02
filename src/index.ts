import 'dotenv/config';
import { CronJob } from 'cron';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Message as TelegramMessage, MessageEntity } from 'telegraf/types';
import editSessionStore from './editSessionStore.js';
import jobStore, { type JobContentType, type ScheduledJob } from './jobStore.js';
import messageStore, { type StoredMessage } from './messageStore.js';
import configStore from './configStore.js';
import { startPanelServer } from './panelServer.js';
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Brak BOT_TOKEN w pliku .env');
  process.exit(1);
}

const bot = new Telegraf(token);
const isPanelEnabled = process.env.START_PANEL === 'true';


const telegramMenuCommands = [
  { command: 'ping', description: 'Sprawdzenie czy bot działa' },
  { command: 'schedule', description: 'Utwórz zadanie cron w czacie' },
  { command: 'schedule_channel', description: 'Utwórz zadanie cron na kanał' },
  { command: 'test_post', description: 'Wyślij testowy post' },
  { command: 'list_posts', description: 'Lista zaplanowanych postów' },
  { command: 'list_jobs', description: 'Lista aktywnych zadań cron' },
  { command: 'list_admins', description: 'Wyświetl listę adminów' },
  { command: 'add_admin', description: 'Dodaj admina (reply lub ID)' },
  { command: 'remove_admin', description: 'Usuń admina (reply lub ID)' },
  { command: 'current_channel', description: 'Pokaż ustawiony kanał' },
  { command: 'set_channel', description: 'Ustaw kanał (reply lub ID)' },
];

type ReplyOptions = Parameters<Context['reply']>[1];

const replyWithTracking = async (
  ctx: Context,
  text: string,
  source: string,
  extra?: ReplyOptions,
) => {
  const sentMessage = await ctx.reply(text, extra);
  messageStore.recordTelegramMessage(sentMessage, source);
  return sentMessage;
};

const requireAdmin = async (ctx: Context): Promise<boolean> => {
  const userId = ctx.from?.id;
  if (typeof userId !== 'number') {
    await replyWithTracking(
      ctx,
      'Brak kontekstu użytkownika. Ta komenda wymaga uprawnień administratora.',
      'require_admin:no_user',
    );
    return false;
  }
  if (configStore.isAdmin(userId)) {
    return true;
  }
  const became = configStore.ensureBootstrapAdmin(userId);
  if (became) {
    await replyWithTracking(
      ctx,
      'Nie było żadnych adminów, dodano Cię jako pierwszego administratora.',
      'require_admin:bootstrap',
    );
    return true;
  }
  await replyWithTracking(ctx, 'Nie masz uprawnień administratora.', 'require_admin:denied');
  return false;
};

const parseNumericArgument = (ctx: Context): number | null => {
  const message = ctx.message as { text?: string } | undefined;
  const text = message?.text?.trim();
  if (!text) {
    return null;
  }
  const [, param] = text.split(/\s+/);
  if (!param) {
    return null;
  }
  const parsed = Number(param);
  return Number.isNaN(parsed) ? null : parsed;
};

type MessageWithForward = {
  reply_to_message?: {
    forward_from_chat?: {
      id?: number;
    };
  };
  forward_from_chat?: {
    id?: number;
  };
};

const sendToChatWithTracking = async (
  chatId: number,
  text: string,
  source: string,
  extra?: Parameters<typeof bot.telegram.sendMessage>[2],
) => {
  const sentMessage = await bot.telegram.sendMessage(chatId, text, extra);
  messageStore.recordTelegramMessage(sentMessage, source);
  return sentMessage;
};

const getChannelId = (): number | null => configStore.getMainChannelId();

const requireChannelId = async (ctx: Context) => {
  const channelId = getChannelId();
  if (channelId === null) {
    await ctx.reply(
      'Kanał nie jest skonfigurowany. Ustaw CHANNEL_ID w środowisku lub użyj /set_channel, aby zapisać kanał.',
    );
    return null;
  }
  return channelId;
};

const sendScheduledJobContent = async (job: ScheduledJob) => {
  const source = `schedule:message:${job.id}`;
  if (job.contentType === 'text') {
    const textToSend = job.text ?? '';
    if (!textToSend) {
      console.warn(`Zadanie #${job.id} nie ma treści tekstowej.`);
      return;
    }
    const extra = job.entities ? { entities: job.entities } : undefined;
    await sendToChatWithTracking(job.targetChatId, textToSend, source, extra);
    return;
  }

  if (!job.fileId) {
    console.error(`Zadanie #${job.id} nie ma powiązanego pliku.`);
    return;
  }

  const extraBase = job.text ? { caption: job.text } : {};
  const mediaExtra = job.entities
    ? { ...extraBase, caption_entities: job.entities }
    : extraBase;

  if (job.contentType === 'photo') {
    const sent = await bot.telegram.sendPhoto(job.targetChatId, job.fileId, mediaExtra);
    messageStore.recordTelegramMessage(sent, source);
    return;
  }

  if (job.contentType === 'video') {
    const sent = await bot.telegram.sendVideo(job.targetChatId, job.fileId, mediaExtra);
    messageStore.recordTelegramMessage(sent, source);
    return;
  }

  if (job.contentType === 'animation') {
    const sent = await bot.telegram.sendAnimation(job.targetChatId, job.fileId, mediaExtra);
    messageStore.recordTelegramMessage(sent, source);
  }
};

const usageMessages = {
  edit: [
    'Użycie:',
    '/edit_post <message_id> <nowy_tekst>',
    'lub odpowiedz na wiadomość bota: /edit_post Nowa treść',
  ].join('\n'),
  delete: [
    'Użycie:',
    '/delete_post <message_id>',
    'lub odpowiedz na wiadomość bota komendą /delete_post',
  ].join('\n'),
  schedule: [
    'Użycie: /schedule "CRON_Z_SEKUNDAMI" Wiadomość',
    'np: /schedule "*/15 * * * * *" Hello',
    'Odpowiedz na wiadomość tekstową (np. draft kanału), aby zapisać jej treść i formatowanie; nie wpisuj dodatkowego tekstu po cronie.',
  ].join('\n'),
  scheduleChannel: [
    'Użycie: /schedule_channel "CRON_Z_SEKUNDAMI" Treść',
    'Możesz odpowiedzieć na wiadomość tekstową, aby skopiować tekst i formatowanie (tekst komendy zostanie zignorowany).',
    'Lub odpowiedz na media, aby zaplanować zdjęcie/wideo/gif na kanał (jak dotąd).',
  ].join('\n'),
  listPosts: 'Użycie: /list_posts [limit]\nnp: /list_posts 5',
  cancelJob: 'Użycie: /cancel_job <job_id>\nnp: /cancel_job 1',
};

const DEFAULT_LIST_POSTS_LIMIT = 10;
const MAX_LIST_POSTS_LIMIT = 50;

const truncateText = (text: string, max = 80) => {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
};

const describeJobContent = (type: JobContentType) => {
  switch (type) {
    case 'photo':
      return 'media: zdjęcie';
    case 'video':
      return 'media: wideo';
    case 'animation':
      return 'media: gif';
    default:
      return 'tekst';
  }
};

const getTextAndEntities = (
  message?: TelegramMessage,
): { text?: string; entities?: MessageEntity[] } => {
  if (!message) {
    return {};
  }
  const anyMessage = message as any;
  if (typeof anyMessage.text === 'string') {
    return { text: anyMessage.text, entities: anyMessage.entities };
  }
  if (typeof anyMessage.caption === 'string') {
    return { text: anyMessage.caption, entities: anyMessage.caption_entities };
  }
  return {};
};

const isMessageVisibleInListPosts = (message: StoredMessage) => {
  const source = message.source ?? '';
  const isSchedulePost = source.startsWith('schedule:message');
  const isTestPost = source === 'test_post';
  const isSystemLike = source.includes('confirm') || source.includes('usage') || source === 'help';
  return (isSchedulePost || isTestPost) && !isSystemLike;
};

const getReplyMessage = (ctx: Context): TelegramMessage | undefined => {
  return (ctx.message as { reply_to_message?: TelegramMessage } | undefined)?.reply_to_message;
};

const isReplyToBotMessage = (ctx: Context) => {
  const replyFromId = getReplyMessage(ctx)?.from?.id;
  const botId = ctx.botInfo?.id;
  return Boolean(replyFromId && botId && replyFromId === botId);
};

const getReplyTargetIds = (ctx: Context) => {
  const chatId = ctx.chat?.id;
  const replyMessageId = getReplyMessage(ctx)?.message_id;
  if (!chatId || !replyMessageId) {
    return null;
  }
  return { chatId, messageId: replyMessageId };
};

const extractMediaFromMessage = (
  message?: TelegramMessage,
): { contentType: JobContentType; fileId: string } | null => {
  if (!message) {
    return null;
  }
  const payload = message as any;
  if (Array.isArray(payload.photo) && payload.photo.length > 0) {
    const largestPhoto = payload.photo[payload.photo.length - 1];
    return { contentType: 'photo', fileId: largestPhoto.file_id as string };
  }
  if (payload.video?.file_id) {
    return { contentType: 'video', fileId: payload.video.file_id as string };
  }
  if (payload.animation?.file_id) {
    return { contentType: 'animation', fileId: payload.animation.file_id as string };
  }
  return null;
};

const tryDeleteBotMessage = async (chatId: number, messageId: number) => {
  const storedMessage = messageStore.get(chatId, messageId);
  if (!storedMessage || storedMessage.deleted) {
    return {
      success: false,
      message: `Nie znaleziono wiadomości o ID ${messageId} w tym czacie.`,
    };
  }
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
    messageStore.markDeleted(chatId, messageId);
    return {
      success: true,
      message: `Wiadomość ${messageId} została usunięta.`,
    };
  } catch (error) {
    console.error(`Nie udało się usunąć wiadomości ${messageId}`, error);
    return {
      success: false,
      message: 'Nie udało się usunąć wiadomości. Spróbuj ponownie.',
    };
  }
};

const tryEditBotMessage = async (chatId: number, messageId: number, newText: string) => {
  const storedMessage = messageStore.get(chatId, messageId);
  if (!storedMessage || storedMessage.deleted) {
    return {
      success: false,
      message: `Nie znaleziono wiadomości o ID ${messageId} w tym czacie.`,
    };
  }
  try {
    await bot.telegram.editMessageText(chatId, messageId, undefined, newText);
    messageStore.updateText(chatId, messageId, newText);
    return {
      success: true,
      message: `Wiadomość ${messageId} została zmieniona.`,
    };
  } catch (error) {
    console.error(`Nie udało się edytować wiadomości ${messageId}`, error);
    return {
      success: false,
      message: 'Nie udało się edytować wiadomości. Spróbuj ponownie.',
    };
  }
};

const helpMessage = [
  'Dostępne komendy:',
  '/ping – test działania',
  '/schedule – ustaw cron w czacie',
  '/schedule_channel – cron na kanał',
  '/test_post – testowy post',
  '/list_posts – lista postów',
  '/list_jobs – lista zadań',
  '',
  'Komendy administratora:',
  '/list_admins – lista adminów',
  '/add_admin – dodaj admina (reply lub ID)',
  '/remove_admin – usuń admina (reply lub ID)',
  '/current_channel – aktualny kanał',
  '/set_channel – zmień kanał',
].join('\n');

const cronHelpMessage = [
  '⏱️ Jak pisać CRON (6 pól)?',
  'Format: sekunda | minuta | godzina | dzień_miesiąca | miesiąc | dzień_tygodnia',
  '',
  'Znaczenie pól:',
  'sekunda – 0-59',
  'minuta – 0-59',
  'godzina – 0-23',
  'dzień_miesiąca – 1-31',
  'miesiąc – 1-12',
  'dzień_tygodnia – 0-6 (0 = niedziela)',
  '',
  'Symbole:',
  '* – dowolna wartość',
  '*/10 – co 10 jednostek',
  '1,15 – wybrane wartości',
  '1-5 – zakres od 1 do 5',
  '',
  'Przykłady:',
  '*/10 * * * * * – co 10 sekund',
  '0 */5 * * * * – co 5 minut',
  '0 0 9 * * * – codziennie o 9:00',
  '0 0 18 * * 1-5 – w dni robocze o 18:00',
  '',
  'Składnia /schedule:',
  '/schedule "*/10 * * * * *" Hello',
  '',
  'Odpowiedz na wiadomość tekstową (np. draft kanału), aby zaplanować dokładnie tę treść z formatowaniem.',
  'Na kanale możesz też odpowiedzieć na media lub tekst — tekst komendy zostanie zignorowany w trybie reply.',
].join('\n');

// /ping — szybki test działania
bot.command('ping', (ctx) => replyWithTracking(ctx, 'pong', 'ping'));

bot.command('help', (ctx) => replyWithTracking(ctx, helpMessage, 'help'));

bot.command('cron_help', (ctx) => replyWithTracking(ctx, cronHelpMessage, 'cron_help'));

bot.command('list_admins', async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    return;
  }
  const adminIds = configStore.getAdminIds();
  const text =
    adminIds.length === 0
      ? 'Brak zdefiniowanych administratorów.'
      : `Administratorzy:\n${adminIds.map((id) => `- ${id}`).join('\n')}`;
  await replyWithTracking(ctx, text, 'list_admins');
});

bot.command('add_admin', async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    return;
  }
  const replyId = ctx.message?.reply_to_message?.from?.id;
  const targetId = typeof replyId === 'number' ? replyId : parseNumericArgument(ctx);
  if (typeof targetId !== 'number') {
    await replyWithTracking(
      ctx,
      'Podaj ID użytkownika jako argument lub odpowiedz na jego wiadomość.',
      'add_admin:missing',
    );
    return;
  }
  if (configStore.addAdmin(targetId)) {
    await replyWithTracking(ctx, `Dodano administratora ${targetId}.`, 'add_admin:success');
    return;
  }
  await replyWithTracking(ctx, `Administrator ${targetId} już istnieje.`, 'add_admin:exists');
});

bot.command('remove_admin', async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    return;
  }
  const replyId = ctx.message?.reply_to_message?.from?.id;
  const targetId = typeof replyId === 'number' ? replyId : parseNumericArgument(ctx);
  if (typeof targetId !== 'number') {
    await replyWithTracking(
      ctx,
      'Podaj ID użytkownika jako argument lub odpowiedz na jego wiadomość.',
      'remove_admin:missing',
    );
    return;
  }
  if (configStore.removeAdmin(targetId)) {
    await replyWithTracking(ctx, `Usunięto administratora ${targetId}.`, 'remove_admin:success');
  } else {
    await replyWithTracking(ctx, `Administrator ${targetId} nie istnieje.`, 'remove_admin:not_found');
  }
});

bot.command('current_channel', async (ctx) => {
  if (!(await requireAdmin(ctx))) {
    return;
  }
  const channelId = configStore.getMainChannelId();
  const text = channelId
    ? `Aktualny kanał docelowy: ${channelId}`
    : 'Kanał docelowy nie został ustawiony.';
  await replyWithTracking(ctx, text, 'current_channel');
});

bot.command('set_channel', async (ctx) => {
  const message = ctx.message as MessageWithForward | undefined;
  const chat = ctx.chat as { id?: number; type?: string } | undefined;
  const chatType = chat?.type;
  const isChannelContext = chatType === 'channel';
  if (!isChannelContext && !(await requireAdmin(ctx))) {
    return;
  }
  const targetFromContext = isChannelContext ? chat?.id : null;
  const forwardedId =
    message?.reply_to_message?.forward_from_chat?.id ?? message?.forward_from_chat?.id ?? null;
  const targetId =
    typeof targetFromContext === 'number'
      ? targetFromContext
      : forwardedId ?? parseNumericArgument(ctx);
  if (typeof targetId !== 'number') {
    await replyWithTracking(
      ctx,
      'Nie rozpoznano ID kanału. Użyj `/set_channel <id>` lub odpowiedz na wiadomość z kanału.',
      'set_channel:missing',
    );
    return;
  }
  configStore.setMainChannelId(targetId);
  await replyWithTracking(ctx, `Zapisano kanał ${targetId}.`, 'set_channel:confirm');
});

bot.command('channel_test', async (ctx) => {
  const channelId = await requireChannelId(ctx);
  if (channelId === null) {
    return;
  }
  try {
    const sent = await ctx.telegram.sendMessage(channelId, 'To jest testowy post na kanał z bota 🚀');
    messageStore.recordTelegramMessage(sent, 'channel_test');
    await replyWithTracking(
      ctx,
      `Wysłałem post na kanał (message_id: ${sent.message_id}).`,
      'channel_test:confirmation',
    );
  } catch (error) {
    console.error('Błąd przy wysyłaniu na kanał:', error);
    await replyWithTracking(
      ctx,
      'Nie udało się wysłać posta na kanał. Sprawdź, czy bot jest adminem i czy kanał jest poprawnie ustawiony.',
      'channel_test:error',
    );
  }
});

bot.command('channel_test_media', async (ctx) => {
  const channelId = await requireChannelId(ctx);
  if (channelId === null) {
    return;
  }
  const replyMessage = getReplyMessage(ctx);
  if (!replyMessage) {
    return replyWithTracking(
      ctx,
      'Aby użyć /channel_test_media, odpowiedz na wiadomość ze zdjęciem, wideo lub gifem.',
      'channel_test_media:usage',
    );
  }
  const mediaInfo = extractMediaFromMessage(replyMessage);
  if (!mediaInfo) {
    return replyWithTracking(
      ctx,
      'Ta wiadomość nie zawiera obsługiwanego media. Wyślij zdjęcie, wideo lub gif i spróbuj ponownie.',
      'channel_test_media:unsupported',
    );
  }
  try {
    const caption = 'Testowe media na kanał 🚀';
    let sentMessage: TelegramMessage;
    if (mediaInfo.contentType === 'photo') {
      sentMessage = await ctx.telegram.sendPhoto(channelId, mediaInfo.fileId, { caption });
    } else if (mediaInfo.contentType === 'video') {
      sentMessage = await ctx.telegram.sendVideo(channelId, mediaInfo.fileId, { caption });
    } else {
      sentMessage = await ctx.telegram.sendAnimation(channelId, mediaInfo.fileId, { caption });
    }
    messageStore.recordTelegramMessage(sentMessage, 'channel_test_media');
    await replyWithTracking(ctx, 'Wysłałem testowe media na kanał ✅', 'channel_test_media:confirmation');
  } catch (error) {
    console.error('Nie udało się wysłać testowych mediów na kanał.', error);
    await replyWithTracking(
      ctx,
      'Nie udało się wysłać testowych mediów na kanał. Sprawdź uprawnienia bota i spróbuj ponownie.',
      'channel_test_media:error',
    );
  }
});

bot.command('test_post', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return replyWithTracking(ctx, 'Brak identyfikatora czatu.', 'test_post:error');
  }

  const incomingText = ctx.message?.text ?? '';
  const customText = incomingText.replace(/^\/test_post\s*/, '').trim();
  const messageText =
    customText ||
    'To jest testowy post bota. Użyj /list_posts, przycisków ✏️/🗑 albo /edit_post /delete_post, aby poćwiczyć edycję i kasowanie.';

  try {
    const sentMessage = await replyWithTracking(ctx, messageText, 'test_post');
    console.log(
      `[test_post] Wysłano testową wiadomość, id: ${sentMessage.message_id} w czacie ${chatId}`,
    );
    const infoMessage = [
      `Testowy post wysłany (ID: ${sentMessage.message_id}).`,
      'Teraz możesz:',
      '- wpisać /list_posts i zobaczyć post z przyciskami ✏️ Edytuj / 🗑 Usuń,',
      '- kliknąć przyciski pod tym postem,',
      '- albo użyć /edit_post <ID> Nowy tekst i /delete_post <ID>.',
    ].join('\n');
    await replyWithTracking(ctx, infoMessage, 'test_post:info');
  } catch (error) {
    console.error('[test_post] Nie udało się wysłać testowej wiadomości.', error);
    await replyWithTracking(
      ctx,
      'Nie udało się wysłać testowego posta. Spróbuj ponownie.',
      'test_post:error',
    );
  }
});

bot.command('list_posts', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return replyWithTracking(ctx, 'Brak identyfikatora czatu.', 'list_posts:error');
  }

  const text = ctx.message?.text ?? '';
  const match = text.match(/^\/list_posts(?:\s+(\d+))?\s*$/);
  if (!match) {
    return replyWithTracking(ctx, usageMessages.listPosts, 'list_posts:usage');
  }

  let limit = DEFAULT_LIST_POSTS_LIMIT;
  const limitArg = match[1];
  if (limitArg) {
    const parsedLimit = Number(limitArg);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return replyWithTracking(
        ctx,
        'Limit musi być dodatnią liczbą całkowitą, np. /list_posts 5',
        'list_posts:invalid_limit',
      );
    }
    limit = Math.min(parsedLimit, MAX_LIST_POSTS_LIMIT);
  }

  const visibleMessages = messageStore
    .getAllMessagesForChat(chatId)
    .filter(isMessageVisibleInListPosts);

  if (visibleMessages.length === 0) {
    return replyWithTracking(
      ctx,
      'Brak zaplanowanych ani testowych wiadomości w tym czacie.',
      'list_posts:empty',
    );
  }

  const limitedMessages = visibleMessages.slice(0, limit);

  await replyWithTracking(
    ctx,
    `Ostatnie zaplanowane lub testowe wiadomości bota w tym czacie (max ${limit}):`,
    'list_posts:header',
  );

  for (const message of limitedMessages) {
    const textPreview = message.text ? truncateText(message.text.trim(), 60) : '(brak treści)';
    const body = `ID: ${message.messageId}\nŹródło: ${message.source}\nTekst: ${textPreview}`;
    await replyWithTracking(ctx, body, 'list_posts:item', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ Edytuj', callback_data: `edit:${message.messageId}` },
            { text: '🗑 Usuń', callback_data: `delete:${message.messageId}` },
          ],
        ],
      },
    });
  }
});

bot.command('list_jobs', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return replyWithTracking(ctx, 'Brak identyfikatora czatu.', 'list_jobs:error');
  }

  const jobs = jobStore.getJobsForChat(chatId);
  if (jobs.length === 0) {
    return replyWithTracking(ctx, 'Brak aktywnych zadań w tym czacie.', 'list_jobs:empty');
  }

  await replyWithTracking(
    ctx,
    `Aktywne zadania w tym czacie (łącznie ${jobs.length}):`,
    'list_jobs:header',
  );

  for (const job of jobs) {
    const textPreview = job.text?.trim() ? truncateText(job.text.trim(), 60) : '(brak treści)';
    const destinationLabel = job.targetChatId === chatId ? 'ten czat' : 'kanał';
    const body = `Zadanie #${job.id}\nCel: ${destinationLabel}\nCRON: ${job.cronExpr}\nTyp: ${describeJobContent(job.contentType)}\nTekst: ${textPreview}`;
    await replyWithTracking(ctx, body, 'list_jobs:item', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ Edytuj', callback_data: `jobedit:${job.id}` },
            { text: '🛑 Stop', callback_data: `jobstop:${job.id}` },
          ],
        ],
      },
    });
  }
});

// /schedule "*/10 * * * * *" Hello co 10s
bot.command('schedule', async (ctx) => {
  const ownerChatId = ctx.chat?.id;
  if (!ownerChatId) {
    return replyWithTracking(ctx, 'Nie udało się ustalić czatu.', 'schedule:error');
  }
  const text = ctx.message?.text ?? '';
  const match = text.match(/^\/schedule\s+"([^"]+)"(?:\s+([\s\S]+))?\s*$/);
  if (!match || !match[1]) {
    return replyWithTracking(ctx, usageMessages.schedule, 'schedule:usage');
  }
  const cronExpr = match[1];
  const providedMessage = match[2]?.trim() ?? '';

  const replyMessage = getReplyMessage(ctx);
  const mediaInfo = extractMediaFromMessage(replyMessage);
  const { text: replyText, entities: replyEntities } = getTextAndEntities(replyMessage);
  const hasReplyText = typeof replyText === 'string' && replyText.trim().length > 0;
  const hasProvidedMessage = Boolean(providedMessage);
  const isReplyTextMode = Boolean(replyMessage && !mediaInfo && hasReplyText);

  let contentType: JobContentType = 'text';
  let fileId: string | undefined;
  let jobText: string | undefined;
  let jobEntities: MessageEntity[] | undefined;

  if (isReplyTextMode) {
    if (hasProvidedMessage) {
      return replyWithTracking(
        ctx,
        'Użyj /schedule jako reply bez dodatkowego tekstu po cronie, jeśli chcesz skopiować formatowanie z tej wiadomości.',
        'schedule:reply_extra_text',
      );
    }
    jobText = replyText!;
    jobEntities = replyEntities;
  } else if (mediaInfo) {
    contentType = mediaInfo.contentType;
    fileId = mediaInfo.fileId;
    jobText = hasReplyText ? replyText! : providedMessage;
    jobEntities = hasReplyText ? replyEntities : undefined;
  } else {
    jobText = providedMessage;
  }
  if (contentType === 'text' && !jobText) {
    return replyWithTracking(ctx, usageMessages.schedule, 'schedule:usage');
  }
  const targetChatId = ownerChatId;

  try {
    let createdJobId: number | null = null;
    const job = new CronJob(
      cronExpr,
      async () => {
        try {
          if (createdJobId === null) {
            return;
          }
          const jobData = jobStore.getJob(ownerChatId, createdJobId);
          if (!jobData) {
            return;
          }
          await sendScheduledJobContent(jobData);
        } catch (cronError) {
          console.error('Nie udało się wysłać zaplanowanej wiadomości.', cronError);
        }
      },
      null,
      true,
      'Europe/Warsaw',
    );

    const jobRecord = jobStore.addJob({
      ownerChatId,
      targetChatId,
      cronExpr,
      contentType,
      text: jobText,
      fileId,
      entities: jobEntities,
      job,
    });
    createdJobId = jobRecord.id;
    job.start();
    const contentLabel = describeJobContent(jobRecord.contentType);
    return replyWithTracking(
      ctx,
      `OK, zaplanowano zadanie #${jobRecord.id} (${contentLabel}) z cron: ${cronExpr}.`,
      'schedule:confirmation',
    );
  } catch (e: any) {
    return replyWithTracking(ctx, `Błąd crona: ${e?.message ?? e}`, 'schedule:error');
  }
});

bot.command('schedule_channel', async (ctx) => {
  const ownerChatId = ctx.chat?.id;
  if (!ownerChatId) {
    return replyWithTracking(ctx, 'Nie udało się ustalić czatu.', 'schedule_channel:error');
  }
  const channelId = await requireChannelId(ctx);
  if (channelId === null) {
    return;
  }
  const text = ctx.message?.text ?? '';
  const match = text.match(/^\/schedule_channel\s+"([^"]+)"(?:\s+([\s\S]+))?\s*$/);
  if (!match || !match[1]) {
    return replyWithTracking(ctx, usageMessages.scheduleChannel, 'schedule_channel:usage');
  }
  const cronExpr = match[1];
  const providedMessage = match[2]?.trim() ?? '';

  const replyMessage = getReplyMessage(ctx);
  const mediaInfo = extractMediaFromMessage(replyMessage);
  const { text: replyText, entities: replyEntities } = getTextAndEntities(replyMessage);
  const hasReplyText = typeof replyText === 'string' && replyText.trim().length > 0;
  const hasProvidedMessage = Boolean(providedMessage);
  const isReplyTextMode = Boolean(replyMessage && !mediaInfo && hasReplyText);

  let contentType: JobContentType = 'text';
  let fileId: string | undefined;
  let jobText: string | undefined;
  let jobEntities: MessageEntity[] | undefined;

  if (isReplyTextMode) {
    jobText = replyText!;
    jobEntities = replyEntities;
  } else if (mediaInfo) {
    contentType = mediaInfo.contentType;
    fileId = mediaInfo.fileId;
    jobText = hasReplyText ? replyText! : providedMessage;
    jobEntities = hasReplyText ? replyEntities : undefined;
  } else {
    jobText = providedMessage;
  }
  if (contentType === 'text' && !jobText) {
    return replyWithTracking(ctx, usageMessages.scheduleChannel, 'schedule_channel:usage');
  }

  try {
    let createdJobId: number | null = null;
    const job = new CronJob(
      cronExpr,
      async () => {
        try {
          if (createdJobId === null) {
            return;
          }
          const jobData = jobStore.getJob(ownerChatId, createdJobId);
          if (!jobData) {
            return;
          }
          await sendScheduledJobContent(jobData);
        } catch (cronError) {
          console.error('Nie udało się wysłać zaplanowanej wiadomości na kanał.', cronError);
        }
      },
      null,
      true,
      'Europe/Warsaw',
    );

    const jobRecord = jobStore.addJob({
      ownerChatId,
      targetChatId: channelId,
      cronExpr,
      contentType,
      text: jobText,
      fileId,
      entities: jobEntities,
      job,
    });
    createdJobId = jobRecord.id;
    job.start();
    const contentLabel = describeJobContent(jobRecord.contentType);
    const replyModeNote =
      isReplyTextMode && hasProvidedMessage
        ? '\nTekst komendy został zignorowany; użyto wiadomości, na którą odpowiedziałeś.'
        : '';
    return replyWithTracking(
      ctx,
      `OK, zaplanowano zadanie kanałowe #${jobRecord.id} (${contentLabel}) z cron: ${cronExpr}.${replyModeNote}`,
      'schedule_channel:confirmation',
    );
  } catch (e: any) {
    return replyWithTracking(ctx, `Błąd crona: ${e?.message ?? e}`, 'schedule_channel:error');
  }
});

bot.command('edit_post', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return replyWithTracking(ctx, 'Brak identyfikatora czatu.', 'edit_post:error');
  }
  const text = ctx.message?.text ?? '';
  const withIdMatch = text.match(/^\/edit_post\s+(\d+)\s+([\s\S]+)$/);
  if (withIdMatch && withIdMatch[1] && withIdMatch[2]) {
    const messageId = Number(withIdMatch[1]);
    const newText = withIdMatch[2].trim();
    if (!Number.isInteger(messageId) || !newText) {
      return replyWithTracking(ctx, usageMessages.edit, 'edit_post:usage');
    }
    const result = await tryEditBotMessage(chatId, messageId, newText);
    const source = result.success ? 'edit_post:confirmation' : 'edit_post:error';
    return replyWithTracking(ctx, result.message, source);
  }

  const replyTarget = getReplyTargetIds(ctx);
  if (replyTarget) {
    if (!isReplyToBotMessage(ctx)) {
      return replyWithTracking(
        ctx,
        'Można edytować tylko wiadomości wysłane przez tego bota. Odpowiedz na właściwą wiadomość.',
        'edit_post:reply_not_bot',
      );
    }
    const newText = text.replace(/^\/edit_post\s*/, '').trim();
    if (!newText) {
      return replyWithTracking(
        ctx,
        'Podaj nową treść po komendzie, np. odpowiadając: /edit_post Nowa treść',
        'edit_post:reply_missing_text',
      );
    }
    const result = await tryEditBotMessage(chatId, replyTarget.messageId, newText);
    const source = result.success ? 'edit_post:reply_confirmation' : 'edit_post:reply_error';
    return replyWithTracking(ctx, result.message, source);
  }

  return replyWithTracking(ctx, usageMessages.edit, 'edit_post:usage');
});

bot.command('delete_post', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return replyWithTracking(ctx, 'Brak identyfikatora czatu.', 'delete_post:error');
  }
  const text = ctx.message?.text ?? '';
  const match = text.match(/^\/delete_post\s+(\d+)\s*$/);
  if (match && match[1]) {
    const messageId = Number(match[1]);
    if (!Number.isInteger(messageId)) {
      return replyWithTracking(ctx, usageMessages.delete, 'delete_post:usage');
    }
    const result = await tryDeleteBotMessage(chatId, messageId);
    const source = result.success ? 'delete_post:confirmation' : 'delete_post:error';
    return replyWithTracking(ctx, result.message, source);
  }

  const replyTarget = getReplyTargetIds(ctx);
  if (replyTarget) {
    if (!isReplyToBotMessage(ctx)) {
      return replyWithTracking(
        ctx,
        'Można usuwać tylko wiadomości wysłane przez tego bota. Odpowiedz na właściwą wiadomość.',
        'delete_post:reply_not_bot',
      );
    }
    const result = await tryDeleteBotMessage(chatId, replyTarget.messageId);
    const source = result.success ? 'delete_post:reply_confirmation' : 'delete_post:reply_error';
    return replyWithTracking(ctx, result.message, source);
  }

  return replyWithTracking(ctx, usageMessages.delete, 'delete_post:usage');
});

bot.command('cancel_job', (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return replyWithTracking(ctx, 'Brak identyfikatora czatu.', 'cancel_job:error');
  }
  const text = ctx.message?.text ?? '';
  const match = text.match(/^\/cancel_job\s+(\d+)\s*$/);
  if (!match || !match[1]) {
    return replyWithTracking(ctx, usageMessages.cancelJob, 'cancel_job:usage');
  }
  const jobId = Number(match[1]);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return replyWithTracking(ctx, usageMessages.cancelJob, 'cancel_job:usage');
  }

  const removedJob = jobStore.removeJob(chatId, jobId);
  if (!removedJob) {
    return replyWithTracking(
      ctx,
      `Nie znaleziono zadania #${jobId} w tym czacie.`,
      'cancel_job:not_found',
    );
  }

  return replyWithTracking(ctx, `Zadanie #${jobId} zostało zatrzymane.`, 'cancel_job:confirmation');
});

bot.on('callback_query', async (ctx) => {
  const callback = ctx.callbackQuery;
  if (!('data' in callback) || !callback.data) {
    await ctx.answerCbQuery('Brak danych przycisku.');
    return;
  }
  const chatId = callback.message?.chat.id;
  const userId = ctx.from?.id;
  if (!chatId) {
    await ctx.answerCbQuery('Brak czatu dla przycisku.');
    return;
  }
  const [action, rawId] = callback.data.split(':');
  const targetId = Number(rawId);
  if (!Number.isInteger(targetId)) {
    await ctx.answerCbQuery('Niepoprawne dane przycisku.');
    return;
  }

  if (action === 'jobstop') {
    await ctx.answerCbQuery('Zatrzymuję zadanie...');
    const removed = jobStore.removeJob(chatId, targetId);
    if (!removed) {
      await replyWithTracking(
        ctx,
        `Nie znaleziono zadania #${targetId} w tym czacie.`,
        'callback_jobstop:not_found',
      );
    } else {
      await replyWithTracking(
        ctx,
        `Zadanie #${targetId} zostało zatrzymane.`,
        'callback_jobstop:confirmation',
      );
    }
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  if (action === 'jobedit') {
    if (!userId) {
      await ctx.answerCbQuery('Brak użytkownika.');
      return;
    }
    const job = jobStore.getJob(chatId, targetId);
    if (!job) {
      await ctx.answerCbQuery('Nie znaleziono zadania.');
      await replyWithTracking(
        ctx,
        `Nie znaleziono zadania #${targetId} w tym czacie.`,
        'callback_jobedit:not_found',
      );
      await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
      return;
    }
    editSessionStore.startJobSession(chatId, userId, targetId);
    await ctx.answerCbQuery('Przygotowuję edycję zadania...');
    await replyWithTracking(
      ctx,
      `Edytujemy zadanie #${targetId}. Wyślij teraz nową treść wiadomości.`,
      'callback_jobedit:started',
    );
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  if (action === 'delete') {
    await ctx.answerCbQuery('Usuwam wiadomość...');
    const result = await tryDeleteBotMessage(chatId, targetId);
    const source = result.success ? 'callback_delete:confirmation' : 'callback_delete:error';
    await replyWithTracking(ctx, result.message, source);
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  if (action === 'edit') {
    if (!userId) {
      await ctx.answerCbQuery('Brak użytkownika.');
      return;
    }
    const storedMessage = messageStore.get(chatId, targetId);
    if (!storedMessage || storedMessage.deleted) {
      await ctx.answerCbQuery('Nie znaleziono wiadomości.');
      await replyWithTracking(
        ctx,
        `Nie znaleziono wiadomości o ID ${targetId} w tym czacie.`,
        'callback_edit:not_found',
      );
      await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
      return;
    }
    editSessionStore.startMessageSession(chatId, userId, targetId);
    await ctx.answerCbQuery('Przygotowuję edycję...');
    await replyWithTracking(
      ctx,
      `OK, edytujemy wiadomość o ID ${targetId}. Wyślij nową treść w kolejnym komunikacie.`,
      'callback_edit:started',
    );
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  await ctx.answerCbQuery('Nieznana akcja.');
});

bot.on('text', async (ctx, next?: () => Promise<void>) => {
  const callNext = () => (next ? next() : Promise.resolve());
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) {
    return callNext();
  }

  const session = editSessionStore.get(chatId, userId);
  if (!session) {
    return callNext();
  }

  const newText = ctx.message?.text?.trim();
  if (!newText) {
    editSessionStore.clear(chatId, userId);
    await replyWithTracking(
      ctx,
      'Nowa treść nie może być pusta. Sesję edycji anulowano.',
      'edit_session:empty',
    );
    return;
  }

  if (session.target.type === 'message') {
    const result = await tryEditBotMessage(chatId, session.target.messageId, newText);
    const source = result.success ? 'edit_session:confirmation' : 'edit_session:error';
    await replyWithTracking(ctx, result.message, source);
    editSessionStore.clear(chatId, userId);
    return;
  }

  if (session.target.type === 'job') {
    const updated = jobStore.updateJobText(chatId, session.target.jobId, newText);
    if (!updated) {
      await replyWithTracking(
        ctx,
        `Nie znaleziono zadania #${session.target.jobId} w tym czacie.`,
        'edit_session_job:not_found',
      );
      editSessionStore.clear(chatId, userId);
      return;
    }
    await replyWithTracking(
      ctx,
      `Treść zadania #${session.target.jobId} została zaktualizowana.`,
      'edit_session_job:confirmation',
    );
    editSessionStore.clear(chatId, userId);
    return;
  }

  editSessionStore.clear(chatId, userId);
});

const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
  console.log(`Stopping (${signal})…`);
  try {
    await bot.stop(signal);
  } catch (error: unknown) {
    console.error('Błąd podczas zatrzymywania bota:', error);
  }
  process.exit(0);
};

const main = async () => {
  await bot.telegram.setMyCommands(telegramMenuCommands);
  await bot.launch();
  console.log('Bot działa.');

  if (isPanelEnabled) {
    console.log('START_PANEL=true – uruchamiam panel HTTP...');
    await startPanelServer();
  } else {
    console.log('Panel wyłączony (START_PANEL != true).');
  }
};

main().catch((error) => {
  console.error('Błąd przy uruchamianiu bota/panela:', error);
  process.exit(1);
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
