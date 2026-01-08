import 'dotenv/config';
import { CronJob } from 'cron';
import { Markup, Telegraf } from 'telegraf';
import editSessionStore from './editSessionStore.js';
import jobStore, {} from './jobStore.js';
import messageStore, {} from './messageStore.js';
import configStore, { isProd } from './configStore.js';
import sessionStore, {} from './sessionStore.js';
import { startPanelServer } from './panelServer.js';
const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('Brak BOT_TOKEN w pliku .env');
    process.exit(1);
}
const bot = new Telegraf(token);
const isPanelEnabled = process.env.START_PANEL === 'true';
const BOT_COMMANDS = [
    { command: 'ping', description: 'Sprawdź czy bot działa' },
    // Planowanie
    { command: 'schedule', description: 'Cron: wysyłaj w czacie' },
    { command: 'schedule_channel', description: 'Cron: wysyłaj na kanał' },
    { command: 'test_post', description: 'Wyślij post testowy' },
    { command: 'wizard', description: 'Prosty kreator harmonogramu (reply na wiadomość)' },
    // Posty / zadania
    { command: 'list_posts', description: 'Lista zaplanowanych postów' },
    { command: 'list_jobs', description: 'Aktywne zadania cron' },
    { command: 'stats', description: 'Podsumowanie zadań i prostych statystyk' },
    // Kanał
    { command: 'current_channel', description: 'Pokaż kanał' },
    { command: 'set_channel', description: 'Ustaw kanał (reply lub ID)' },
    // Admini
    { command: 'list_admins', description: 'Wyświetl adminów' },
    { command: 'add_admin', description: 'Dodaj admina (reply/ID)' },
    { command: 'remove_admin', description: 'Usuń admina (reply/ID)' },
    // System / debug
    { command: 'debug_config', description: 'Podgląd konfiguracji bota' },
    { command: 'wizard_channel', description: 'Wizard kanału (once/daily/weekly)' },
];
const replyWithTracking = async (ctx, text, source, extra) => {
    const sentMessage = await ctx.reply(text, extra);
    messageStore.recordTelegramMessage(sentMessage, source);
    return sentMessage;
};
const isAdminCtx = async (ctx) => {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number') {
        return false;
    }
    return configStore.isAdmin(userId);
};
const requireAdmin = async (ctx, { notify = true } = {}) => {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number') {
        if (notify) {
            await replyWithTracking(ctx, 'Brak kontekstu użytkownika. Ta komenda wymaga uprawnień administratora.', 'require_admin:no_user');
        }
        return false;
    }
    if (configStore.isAdmin(userId)) {
        return true;
    }
    const isProduction = process.env.NODE_ENV === 'production';
    if (!isProduction) {
        const became = configStore.ensureBootstrapAdmin(userId);
        if (became) {
            if (notify) {
                await replyWithTracking(ctx, 'Nie było żadnych adminów, dodano Cię jako pierwszego administratora.', 'require_admin:bootstrap');
            }
            return true;
        }
    }
    if (notify) {
        const message = isProduction
            ? 'Nie masz uprawnień administratora. Na produkcji admini muszą być ustawieni przez ADMIN_IDS w środowisku.'
            : 'Nie masz uprawnień administratora.';
        await replyWithTracking(ctx, message, 'require_admin:denied');
    }
    return false;
};
const buildHelpMenuPayload = (isAdmin) => {
    const text = '✨ <b>Panel pomocy</b>\n\n' +
        'Wybierz kategorię, żeby zobaczyć szczegóły:\n\n' +
        '📌 Podstawowe\n' +
        '🕒 Planowanie postów\n' +
        '📑 Zadania CRON\n' +
        '📢 Kanał\n' +
        (isAdmin ? '🛡 Administracja\n' : '') +
        '🔧 Debug / system';
    const buttons = [
        [Markup.button.callback('📌 Podstawowe', 'help:basic')],
        [Markup.button.callback('🕒 Planowanie', 'help:plan')],
        [Markup.button.callback('📑 Zadania CRON', 'help:jobs')],
        [Markup.button.callback('📢 Kanał', 'help:channel')],
    ];
    if (isAdmin) {
        buttons.push([Markup.button.callback('🛡 Admin', 'help:admin')]);
    }
    buttons.push([Markup.button.callback('🔧 Debug / system', 'help:debug')]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
};
const safeEditHelpMessage = async (ctx, text, keyboard) => {
    const options = { parse_mode: 'HTML', ...keyboard };
    try {
        await ctx.editMessageText(text, options);
    }
    catch {
        await ctx.reply(text, options);
    }
};
const showHelpMainMenu = async (ctx) => {
    const payload = buildHelpMenuPayload(await isAdminCtx(ctx));
    await safeEditHelpMessage(ctx, payload.text, payload.keyboard);
};
const parseNumericArgument = (ctx) => {
    const message = ctx.message;
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
const sendToChatWithTracking = async (chatId, text, source, extra) => {
    const sentMessage = await bot.telegram.sendMessage(chatId, text, extra);
    messageStore.recordTelegramMessage(sentMessage, source);
    return sentMessage;
};
const getChannelId = () => configStore.getMainChannelId();
const requireChannelId = async (ctx) => {
    const channelId = getChannelId();
    if (channelId === null) {
        await ctx.reply('Kanał nie jest skonfigurowany. Ustaw CHANNEL_ID w środowisku lub użyj /set_channel, aby zapisać kanał.');
        return null;
    }
    return channelId;
};
const sendScheduledJobContent = async (job) => {
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
const createScheduledJob = (ownerChatId, targetChatId, cronExpr, payload, metadata) => {
    let createdJobId = null;
    const job = new CronJob(cronExpr, async () => {
        try {
            if (createdJobId === null) {
                return;
            }
            const jobData = jobStore.getJob(ownerChatId, createdJobId);
            if (!jobData) {
                return;
            }
            await sendScheduledJobContent(jobData);
            if (jobData.repeat === 'none') {
                jobStore.removeJob(ownerChatId, createdJobId);
            }
        }
        catch (cronError) {
            console.error('Nie udało się wysłać zaplanowanej wiadomości.', cronError);
        }
    }, null, true, 'Europe/Warsaw');
    const jobRecord = jobStore.addJob({
        ownerChatId,
        targetChatId,
        cronExpr,
        contentType: payload.contentType,
        text: payload.text,
        fileId: payload.fileId,
        entities: payload.entities,
        scheduledAt: metadata?.scheduledAt,
        repeat: metadata?.repeat,
        type: metadata?.type ?? 'cron',
        job,
    });
    createdJobId = jobRecord.id;
    job.start();
    return jobRecord;
};
const DEFAULT_LIST_POSTS_LIMIT = 10;
const MAX_LIST_POSTS_LIMIT = 50;
const truncateText = (text, max = 80) => {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, Math.max(0, max - 3))}...`;
};
const DOW_LABELS = {
    0: 'nd',
    1: 'pn',
    2: 'wt',
    3: 'śr',
    4: 'czw',
    5: 'pt',
    6: 'sob',
    7: 'nd',
};
const DOW_ORDER = ['pn', 'wt', 'śr', 'czw', 'pt', 'sob', 'nd'];
const incrementCounter = (map, key) => {
    map.set(key, (map.get(key) ?? 0) + 1);
};
const normalizeHourField = (value) => {
    const trimmed = value.trim();
    if (!/^\d{1,2}$/.test(trimmed)) {
        return null;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 23) {
        return null;
    }
    return parsed.toString().padStart(2, '0');
};
const getDowLabel = (value) => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
        return null;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
        return null;
    }
    return DOW_LABELS[parsed] ?? null;
};
const getNextRunFromJob = (job) => {
    if (!job.job) {
        return undefined;
    }
    try {
        const nextDateTime = job.job.nextDate();
        if (!nextDateTime) {
            return undefined;
        }
        if (typeof nextDateTime.toJSDate === 'function') {
            return nextDateTime.toJSDate();
        }
        if (typeof nextDateTime.toISO === 'function') {
            const iso = nextDateTime.toISO();
            if (typeof iso === 'string') {
                return new Date(iso);
            }
        }
    }
    catch (error) {
        console.warn('Nie udało się odczytać następnego uruchomienia zadania.', error);
    }
    return undefined;
};
const describeJobContent = (type) => {
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
const getTextAndEntities = (message) => {
    if (!message) {
        return {};
    }
    const anyMessage = message;
    if (typeof anyMessage.text === 'string') {
        return { text: anyMessage.text, entities: anyMessage.entities };
    }
    if (typeof anyMessage.caption === 'string') {
        return { text: anyMessage.caption, entities: anyMessage.caption_entities };
    }
    return {};
};
const isMessageVisibleInListPosts = (message) => {
    const source = message.source ?? '';
    const isSchedulePost = source.startsWith('schedule:message');
    const isTestPost = source === 'test_post';
    const isSystemLike = source.includes('confirm') || source.includes('usage') || source === 'help';
    return (isSchedulePost || isTestPost) && !isSystemLike;
};
const getReplyMessage = (ctx) => {
    return ctx.message?.reply_to_message;
};
const isReplyToBotMessage = (ctx) => {
    const replyFromId = getReplyMessage(ctx)?.from?.id;
    const botId = ctx.botInfo?.id;
    return Boolean(replyFromId && botId && replyFromId === botId);
};
const getReplyTargetIds = (ctx) => {
    const chatId = ctx.chat?.id;
    const replyMessageId = getReplyMessage(ctx)?.message_id;
    if (!chatId || !replyMessageId) {
        return null;
    }
    return { chatId, messageId: replyMessageId };
};
const extractMediaFromMessage = (message) => {
    if (!message) {
        return null;
    }
    const payload = message;
    if (Array.isArray(payload.photo) && payload.photo.length > 0) {
        const largestPhoto = payload.photo[payload.photo.length - 1];
        return { contentType: 'photo', fileId: largestPhoto.file_id };
    }
    if (payload.video?.file_id) {
        return { contentType: 'video', fileId: payload.video.file_id };
    }
    if (payload.animation?.file_id) {
        return { contentType: 'animation', fileId: payload.animation.file_id };
    }
    return null;
};
const extractPayloadFromMessage = (message) => {
    if (!message) {
        return null;
    }
    const mediaInfo = extractMediaFromMessage(message);
    const { text: replyText, entities: replyEntities } = getTextAndEntities(message);
    const hasReplyText = typeof replyText === 'string' && replyText.trim().length > 0;
    if (!mediaInfo && !hasReplyText) {
        return null;
    }
    if (mediaInfo) {
        const payload = {
            contentType: mediaInfo.contentType,
            fileId: mediaInfo.fileId,
        };
        if (hasReplyText && replyText) {
            payload.text = replyText.trim();
            if (replyEntities && replyEntities.length > 0) {
                payload.entities = replyEntities;
            }
        }
        return payload;
    }
    const trimmed = replyText?.trim();
    if (!trimmed) {
        return null;
    }
    const payload = {
        contentType: 'text',
        text: trimmed,
    };
    if (replyEntities && replyEntities.length > 0) {
        payload.entities = replyEntities;
    }
    return payload;
};
const wizardSessions = new Map();
const getWizardSessionKey = (chatId, userId) => `${chatId}:${userId}`;
const removeWizardSession = (chatId, userId) => wizardSessions.delete(getWizardSessionKey(chatId, userId));
const buildWizardModeKeyboard = () => Markup.inlineKeyboard([
    [Markup.button.callback('📅 Jednorazowo (data + godzina)', 'wizard:mode:once')],
    [Markup.button.callback('⏰ Codziennie o godzinie', 'wizard:mode:daily')],
    [Markup.button.callback('📆 Co tydzień (dzień + godzina)', 'wizard:mode:weekly')],
    [Markup.button.callback('❌ Anuluj', 'wizard:cancel')],
]);
const buildLocationKeyboard = (hasChannel) => {
    const rows = [
        [Markup.button.callback('💬 Ten czat', 'wizard:location:current')],
        [
            Markup.button.callback(hasChannel ? '📣 Kanał domyślny' : '📣 Kanał domyślny (nie ustawiony)', 'wizard:location:default'),
        ],
        [Markup.button.callback('❌ Anuluj', 'wizard:cancel')],
    ];
    return Markup.inlineKeyboard(rows);
};
const removeDiacritics = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const normalizeWeekday = (value) => removeDiacritics(value.toLowerCase().replace(/\./g, ''));
const WEEKDAY_ALIASES = (() => {
    const groups = [
        [0, ['sun', 'sunday', 'nie', 'niedziela', 'ndz']],
        [1, ['mon', 'monday', 'pon', 'poniedzialek', 'poniedziałek', 'pn']],
        [2, ['tue', 'tuesday', 'wt', 'wtorek']],
        [3, ['wed', 'wednesday', 'sr', 'sroda', 'środa']],
        [4, ['thu', 'thursday', 'czw', 'czwartek']],
        [5, ['fri', 'friday', 'pt', 'piatek', 'piątek']],
        [6, ['sat', 'saturday', 'sob', 'sobota']],
    ];
    const map = {};
    for (const [day, aliases] of groups) {
        for (const alias of aliases) {
            map[removeDiacritics(alias.toLowerCase())] = day;
        }
    }
    return map;
})();
const getDatetimePrompt = (mode) => {
    switch (mode) {
        case 'once':
            return 'Podaj datę i godzinę w formacie DD.MM.RRRR HH:MM.';
        case 'daily':
            return 'Podaj godzinę w formacie HH:MM.';
        case 'weekly':
            return 'Podaj dzień tygodnia i godzinę w formacie DDD HH:MM (np. pt 18:00).';
        default:
            return 'Podaj datę i godzinę.';
    }
};
const WIZARD_CALLBACK_PREFIX = 'wizard';
const promptWizardMode = async (ctx, session) => {
    session.step = 'mode';
    await replyWithTracking(ctx, 'Wybierz sposób harmonogramu:', 'wizard:mode_prompt', buildWizardModeKeyboard());
};
const promptWizardLocation = async (ctx, session) => {
    session.step = 'location';
    const channelId = configStore.getMainChannelId();
    const channelHint = channelId
        ? ''
        : '\nBrak skonfigurowanego kanału domyślnego. Użyj /set_channel, aby go ustawić.';
    await replyWithTracking(ctx, `Gdzie publikować ten post?${channelHint}`, 'wizard:location_prompt', buildLocationKeyboard(Boolean(channelId)));
};
const parseDateTimeDdMmYyyy = (value) => {
    const match = value.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!match) {
        return null;
    }
    const [, dayStr, monthStr, yearStr, hourStr, minuteStr] = match;
    const day = Number(dayStr);
    const month = Number(monthStr);
    const year = Number(yearStr);
    const hour = Number(hourStr);
    const minute = Number(minuteStr);
    if (Number.isNaN(day) ||
        Number.isNaN(month) ||
        Number.isNaN(year) ||
        Number.isNaN(hour) ||
        Number.isNaN(minute)) {
        return null;
    }
    const date = new Date(year, month - 1, day, hour, minute, 0);
    if (date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day ||
        date.getHours() !== hour ||
        date.getMinutes() !== minute) {
        return null;
    }
    return date;
};
const parseWeeklyInput = (value) => {
    const match = value.trim().match(/^([^\s]+)\s+(\d{1,2}:\d{2})$/);
    if (!match) {
        return null;
    }
    const daySegment = match[1];
    const timeSegment = match[2];
    if (!daySegment || !timeSegment) {
        return null;
    }
    const rawDay = normalizeWeekday(daySegment);
    const dayOfWeek = WEEKDAY_ALIASES[rawDay];
    if (dayOfWeek === undefined) {
        return null;
    }
    const time = parseHHMM(timeSegment);
    if (!time) {
        return null;
    }
    return { dayOfWeek, hour: time.hour, minute: time.minute };
};
const buildCronFromSession = (session) => {
    if (!session.mode) {
        return null;
    }
    if (session.mode === 'once') {
        const { onceDate } = session;
        if (!onceDate) {
            return null;
        }
        const minute = onceDate.getMinutes();
        const hour = onceDate.getHours();
        const day = onceDate.getDate();
        const month = onceDate.getMonth() + 1;
        return {
            cron: `0 ${minute} ${hour} ${day} ${month} *`,
            repeat: 'none',
            scheduledAt: onceDate.toISOString(),
        };
    }
    const { time } = session;
    if (!time) {
        return null;
    }
    const minute = time.minute;
    const hour = time.hour;
    if (session.mode === 'daily') {
        return {
            cron: `0 ${minute} ${hour} * * *`,
            repeat: 'daily',
        };
    }
    if (session.mode === 'weekly' && typeof session.dayOfWeek === 'number') {
        return {
            cron: `0 ${minute} ${hour} * * ${session.dayOfWeek}`,
            repeat: 'weekly',
        };
    }
    return null;
};
const handleWizardText = async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const text = ctx.message?.text?.trim();
    if (!chatId || typeof userId !== 'number' || !text) {
        return false;
    }
    const session = wizardSessions.get(getWizardSessionKey(chatId, userId));
    if (!session || session.step !== 'datetime' || !session.mode) {
        return false;
    }
    if (session.mode === 'once') {
        const date = parseDateTimeDdMmYyyy(text);
        if (!date) {
            await replyWithTracking(ctx, 'Niepoprawny format. Użyj DD.MM.RRRR HH:MM, np. 07.12.2025 18:30.', 'wizard:datetime:error');
            return true;
        }
        if (date.getTime() <= Date.now()) {
            await replyWithTracking(ctx, 'Podana data musi być w przyszłości.', 'wizard:datetime:past');
            return true;
        }
        session.onceDate = date;
        session.time = { hour: date.getHours(), minute: date.getMinutes() };
    }
    else if (session.mode === 'daily') {
        const parsed = parseHHMM(text);
        if (!parsed) {
            await replyWithTracking(ctx, 'Niepoprawny format godziny. Użyj HH:MM.', 'wizard:datetime:error');
            return true;
        }
        session.time = parsed;
    }
    else if (session.mode === 'weekly') {
        const parsed = parseWeeklyInput(text);
        if (!parsed) {
            await replyWithTracking(ctx, 'Niepoprawny format. Użyj dzień tygodnia i HH:MM, np. pt 18:00.', 'wizard:datetime:error');
            return true;
        }
        session.dayOfWeek = parsed.dayOfWeek;
        session.time = { hour: parsed.hour, minute: parsed.minute };
    }
    await promptWizardLocation(ctx, session);
    return true;
};
const handleWizardCallback = async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback ||
        !('data' in callback) ||
        typeof callback.data !== 'string' ||
        !callback.data.startsWith(`${WIZARD_CALLBACK_PREFIX}:`)) {
        return false;
    }
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    await ctx.answerCbQuery();
    if (!chatId || typeof userId !== 'number') {
        return true;
    }
    const sessionKey = getWizardSessionKey(chatId, userId);
    const session = wizardSessions.get(sessionKey);
    const [, action, mode] = callback.data.split(':');
    if (action === 'cancel') {
        removeWizardSession(chatId, userId);
        await replyWithTracking(ctx, 'Kreator anulowany.', 'wizard:cancelled');
        return true;
    }
    if (!session) {
        await replyWithTracking(ctx, 'Sesja kreatora wygasła. Napisz /wizard raz jeszcze.', 'wizard:expired');
        return true;
    }
    if (action === 'mode') {
        if (!mode) {
            return true;
        }
        const normalized = mode;
        session.mode = normalized;
        session.step = 'datetime';
        delete session.onceDate;
        delete session.time;
        delete session.dayOfWeek;
        await replyWithTracking(ctx, getDatetimePrompt(normalized), `wizard:prompt:${normalized}`);
        return true;
    }
    if (action === 'location') {
        if (session.step !== 'location') {
            await replyWithTracking(ctx, 'Najpierw wybierz tryb harmonogramu i podaj datę/godzinę.', 'wizard:location:error');
            return true;
        }
        const target = mode;
        const channelId = configStore.getMainChannelId();
        if (target === 'default' && !channelId) {
            await replyWithTracking(ctx, 'Brak skonfigurowanego kanału domyślnego. Ustaw go przez /set_channel.', 'wizard:location:error');
            return true;
        }
        const cronInfo = buildCronFromSession(session);
        if (!cronInfo) {
            await replyWithTracking(ctx, 'Nie udało się przygotować harmonogramu. Spróbuj ponownie.', 'wizard:creation:error');
            removeWizardSession(chatId, userId);
            return true;
        }
        const ownerChatId = session.chatId;
        const targetChatId = target === 'default' ? channelId : ownerChatId;
        try {
            createScheduledJob(ownerChatId, targetChatId, cronInfo.cron, {
                contentType: session.payload.contentType,
                text: session.payload.text,
                entities: session.payload.entities,
                fileId: session.payload.fileId,
            }, {
                repeat: cronInfo.repeat,
                scheduledAt: cronInfo.scheduledAt,
                type: 'post',
            });
            await replyWithTracking(ctx, `Post zaplanowany.\nCron: <code>${cronInfo.cron}</code>`, 'wizard:scheduled', { parse_mode: 'HTML' });
        }
        catch (error) {
            await replyWithTracking(ctx, `Nie udało się zaplanować posta: ${error?.message ?? error}`, 'wizard:scheduled:error');
        }
        removeWizardSession(chatId, userId);
        return true;
    }
    return true;
};
const parseHHMM = (text) => {
    const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
        return null;
    }
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (Number.isNaN(h) || Number.isNaN(mm) || h < 0 || h > 23 || mm < 0 || mm > 59) {
        return null;
    }
    return { hour: h, minute: mm };
};
const parseDateTime = (text) => {
    const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
    if (!m) {
        return null;
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    if (month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59) {
        return null;
    }
    return { year, month, day, hour, minute };
};
const tryDeleteBotMessage = async (chatId, messageId) => {
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
    }
    catch (error) {
        console.error(`Nie udało się usunąć wiadomości ${messageId}`, error);
        return {
            success: false,
            message: 'Nie udało się usunąć wiadomości. Spróbuj ponownie.',
        };
    }
};
const tryEditBotMessage = async (chatId, messageId, newText) => {
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
    }
    catch (error) {
        console.error(`Nie udało się edytować wiadomości ${messageId}`, error);
        return {
            success: false,
            message: 'Nie udało się edytować wiadomości. Spróbuj ponownie.',
        };
    }
};
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
const wizardHelpText = [
    '📅 <b>Planowanie postów – Kreator /wizard</b>',
    '',
    'Kreator pozwala planować posty bez znajomości CRON.',
    'Użycie jest bardzo proste:',
    '',
    '<b>Jak używać /wizard</b>',
    '1. Wyślij normalną wiadomość (tekst lub media z podpisem).',
    '2. Odpowiedz na nią → wpisz <code>/wizard</code>.',
    '3. Wybierz tryb:',
    '   • Jednorazowo',
    '   • Codziennie',
    '   • Co tydzień',
    '4. Wybierz miejsce publikacji:',
    '   • Ten czat',
    '   • Kanał domyślny',
    '5. Wpisz godzinę lub pełną datę.',
    '6. Gotowe – zadanie pojawi się w <b>/list_jobs</b>.',
    '',
    '🧩 <b>Przykłady</b>',
    '',
    '<b>Codziennie o 12:02</b>',
    '→ wyślij draft, odpowiedz /wizard → „Codziennie” → wpisz:',
    '<code>12:02</code>',
    '',
    '<b>W każdy piątek o 18:00</b>',
    '→ wybierz „Co tydzień” → wpisz:',
    '<code>pt 18:00</code>',
    '',
    '<b>Jednorazowo 07.12.2025 o 18:30</b>',
    '→ wybierz „Jednorazowo” → wpisz:',
    '<code>07.12.2025 18:30</code>',
    '',
    '🕒 <b>Formaty akceptowane przez kreator</b>',
    '',
    '<b>Dzienny</b> → <code>HH:MM</code>',
    'Przykład: <code>09:15</code>',
    '',
    '<b>Tygodniowy</b> → <code>DOW HH:MM</code>',
    'Dni tygodnia PL i EN:',
    'pn/mon, wt/tue, śr/wed, cz/thu, pt/fri, sb/sat, nd/sun',
    'Przykład: <code>pt 18:00</code>',
    '',
    '<b>Jednorazowy</b> → <code>DD.MM.YYYY HH:MM</code>',
    'Przykład: <code>07.12.2025 18:30</code>',
    '',
    '✏️ <b>Edycja postów</b> – otwórz <code>/list_posts</code>, kliknij Edytuj i wyślij nową treść.',
].join('\n');
// /ping — szybki test działania
bot.command('ping', (ctx) => replyWithTracking(ctx, 'pong', 'ping'));
bot.command('help', async (ctx) => {
    const isAdminUser = await isAdminCtx(ctx);
    const sections = {
        podstawowe: ['/ping – sprawdź czy bot działa'],
        planowanie: [
            '/schedule – ustaw cron w czacie',
            '/schedule_channel – cron na kanał',
            '/test_post – testowy post',
            '/wizard – prosty kreator harmonogramu (bez CRON-a, używaj jako reply; szczegóły w /help_wizard)',
        ],
        zadania: [
            '/list_posts – lista postów',
            '/list_jobs – aktywne zadania',
            '/stats – podsumowanie zadań i prostych statystyk',
            '/edit – edytuj istniejący post (użyj jako odpowiedzi na wiadomość)',
        ],
        kanal: ['/current_channel – pokaż kanał', '/set_channel – ustaw kanał'],
        admin: ['/list_admins – lista adminów', '/add_admin – dodaj admina', '/remove_admin – usuń admina'],
        debug: ['/debug_config – podgląd konfiguracji'],
    };
    let msg = '✨ <b>Pomoc – dostępne komendy</b>\n\n' +
        '📌 <b>Podstawowe</b>\n' +
        sections.podstawowe.join('\n') +
        '\n\n' +
        '🕒 <b>Planowanie postów</b>\n' +
        sections.planowanie.join('\n') +
        '\n\n' +
        '📑 <b>Zadania</b>\n' +
        sections.zadania.join('\n') +
        '\n\n' +
        '📢 <b>Kanał</b>\n' +
        sections.kanal.join('\n') +
        '\n\n';
    if (isAdminUser) {
        msg += '🛡 <b>Administracja</b>\n' + sections.admin.join('\n') + '\n\n';
    }
    msg += '🔧 <b>Debug / system</b>\n' + sections.debug.join('\n');
    await ctx.reply(msg, { parse_mode: 'HTML' });
});
bot.command('help_wizard', async (ctx) => {
    if (!(await requireAdmin(ctx))) {
        return;
    }
    await replyWithTracking(ctx, wizardHelpText, 'help_wizard', { parse_mode: 'HTML' });
});
bot.command('help_inline', async (ctx) => {
    const payload = buildHelpMenuPayload(await isAdminCtx(ctx));
    const options = { parse_mode: 'HTML', ...payload.keyboard };
    await ctx.reply(payload.text, options);
});
bot.command('cron_help', (ctx) => replyWithTracking(ctx, cronHelpMessage, 'cron_help'));
bot.command('wizard', async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || typeof userId !== 'number') {
        return;
    }
    if (!(await isAdminCtx(ctx))) {
        await replyWithTracking(ctx, 'Nie masz uprawnień admina, żeby używać /wizard.', 'wizard:not_admin');
        return;
    }
    const replyMessage = ctx.message?.reply_to_message;
    if (!replyMessage) {
        await replyWithTracking(ctx, 'Użyj /wizard jako odpowiedzi (reply) na wiadomość z tekstem lub mediami, które chcesz zaplanować.', 'wizard:no_reply');
        return;
    }
    const payload = extractPayloadFromMessage(replyMessage);
    if (!payload) {
        await replyWithTracking(ctx, 'Nie udało się odczytać treści posta. Użyj tekstu, zdjęcia, wideo lub gifa.', 'wizard:payload_missing');
        return;
    }
    const session = {
        chatId,
        userId,
        payload,
        step: 'mode',
    };
    wizardSessions.set(getWizardSessionKey(chatId, userId), session);
    await promptWizardMode(ctx, session);
});
bot.action('help:basic', async (ctx) => {
    await ctx.answerCbQuery();
    const text = '✨ <b>Podstawowe komendy</b>\n\n' +
        '<b>/ping</b> – sprawdź, czy bot działa (powinien odpowiedzieć "pong").\n\n' +
        '<b>/help</b> – klasyczna lista komend w formie tekstowej.\n\n' +
        '<b>/help_inline</b> – panel pomocy z przyciskami.';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Wróć do menu', 'help:back')]]);
    await safeEditHelpMessage(ctx, text, keyboard);
});
bot.action('help:plan', async (ctx) => {
    await ctx.answerCbQuery();
    const text = wizardHelpText;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🧙 Kreator /wizard', 'help:wizard')],
        [Markup.button.callback('📑 Zadania CRON', 'help:jobs')],
        [Markup.button.callback('⬅️ Wróć do menu', 'help:back')],
    ]);
    await safeEditHelpMessage(ctx, text, keyboard);
});
bot.action('help:wizard', async (ctx) => {
    await ctx.answerCbQuery();
    const text = wizardHelpText;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🕒 Planowanie', 'help:plan')],
        [Markup.button.callback('⬅️ Wróć do menu', 'help:back')],
    ]);
    await safeEditHelpMessage(ctx, text, keyboard);
});
bot.action('help:jobs', async (ctx) => {
    await ctx.answerCbQuery();
    const text = '✨ <b>Zarządzanie zadaniami CRON</b>\n\n' +
        '<b>/list_jobs</b> – pokazuje aktywne zadania (pod listą znajdziesz przyciski do zatrzymania lub usunięcia zadania).\n\n' +
        '<b>/stats</b> – podsumowanie zadań, godzin i najbliższego uruchomienia.\n\n' +
        '<b>/list_posts</b> – lista zaplanowanych postów, przycisków ✏️/🗑 do edycji lub kasowania.';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🕒 Planowanie', 'help:plan')],
        [Markup.button.callback('⬅️ Wróć do menu', 'help:back')],
    ]);
    await safeEditHelpMessage(ctx, text, keyboard);
});
bot.action('help:channel', async (ctx) => {
    await ctx.answerCbQuery();
    const text = '✨ <b>Ustawianie kanału</b>\n\n' +
        '<b>/current_channel</b> – pokazuje aktualnie ustawiony kanał.\n\n' +
        '<b>/set_channel</b> – ustawianie kanału na 3 sposoby:\n' +
        '1) W kanale: dodaj bota jako admina i napisz <code>/set_channel</code> w kanale.\n' +
        '2) Reply na przekazaną wiadomość: forward z kanału, reply do tej wiadomości i <code>/set_channel</code>.\n' +
        '3) Po ID: <code>/set_channel -1001234567890</code>.';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🕒 Planowanie', 'help:plan')],
        [Markup.button.callback('⬅️ Wróć do menu', 'help:back')],
    ]);
    await safeEditHelpMessage(ctx, text, keyboard);
});
bot.action('help:admin', async (ctx) => {
    if (!(await isAdminCtx(ctx))) {
        await ctx.answerCbQuery('Ta część jest tylko dla adminów.', { show_alert: true });
        return;
    }
    await ctx.answerCbQuery();
    const text = '🛡 <b>Panel administratora</b>\n\n' +
        '<b>/list_admins</b> – lista adminów.\n\n' +
        '<b>/add_admin</b>\n' +
        '- reply do użytkownika + <code>/add_admin</code> – dodaje go.\n' +
        '- <code>/add_admin 123456789</code> – dodaje ID.\n\n' +
        '<b>/remove_admin</b>\n' +
        '- reply do admina + <code>/remove_admin</code> – usuwa.\n' +
        '- <code>/remove_admin 123456789</code> – usuwa po ID.';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📢 Kanał', 'help:channel')],
        [Markup.button.callback('⬅️ Wróć do menu', 'help:back')],
    ]);
    await safeEditHelpMessage(ctx, text, keyboard);
});
bot.action('help:debug', async (ctx) => {
    await ctx.answerCbQuery();
    const text = '🔧 <b>Debug / system</b>\n\n' +
        '<b>/debug_config</b> – pokazuje tryb (DEV/PROD), adminów widzianych przez bota i aktualny kanał.\n\n' +
        'Uwaga: na produkcji (NODE_ENV=production) admini i kanał są zwykle brane z ENV (ADMIN_IDS, CHANNEL_ID).';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📌 Podstawowe', 'help:basic')],
        [Markup.button.callback('⬅️ Wróć do menu', 'help:back')],
    ]);
    await safeEditHelpMessage(ctx, text, keyboard);
});
bot.action('help:back', async (ctx) => {
    await ctx.answerCbQuery();
    await showHelpMainMenu(ctx);
});
bot.command('list_admins', async (ctx) => {
    if (!(await requireAdmin(ctx))) {
        return;
    }
    const adminIds = configStore.getAdminIds();
    if (adminIds.length === 0) {
        await replyWithTracking(ctx, 'Brak zdefiniowanych administratorów.', 'list_admins:empty');
        return;
    }
    const text = ['Lista adminów:', ...adminIds.map((id) => `• ${id}`)].join('\n');
    const keyboard = Markup.inlineKeyboard(adminIds.map((id) => [Markup.button.callback(`❌ Usuń ${id}`, `rmadmin:${id}`)]));
    await replyWithTracking(ctx, text, 'list_admins', keyboard);
});
bot.command('debug_config', async (ctx) => {
    if (!(await requireAdmin(ctx))) {
        return;
    }
    const admins = configStore.getAdminIds();
    const channelId = configStore.getMainChannelId();
    const nodeEnv = process.env.NODE_ENV ?? 'undefined';
    const modeDescription = isProd ? 'PROD (ENV)' : 'DEV (config file)';
    const text = [
        'Debug config:',
        `NODE_ENV: ${nodeEnv} (${modeDescription})`,
        `Admin IDs: ${admins.length ? admins.join(', ') : 'brak'}`,
        `Main channel ID: ${channelId ?? 'brak'}`,
    ].join('\n');
    await ctx.reply(text);
});
bot.command('add_admin', async (ctx) => {
    if (!(await requireAdmin(ctx))) {
        return;
    }
    const replyId = ctx.message?.reply_to_message?.from?.id;
    const targetId = typeof replyId === 'number' ? replyId : parseNumericArgument(ctx);
    if (typeof targetId !== 'number') {
        await replyWithTracking(ctx, 'Podaj ID użytkownika jako argument lub odpowiedz na jego wiadomość.', 'add_admin:missing');
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
        await replyWithTracking(ctx, 'Podaj ID użytkownika jako argument lub odpowiedz na jego wiadomość.', 'remove_admin:missing');
        return;
    }
    if (configStore.removeAdmin(targetId)) {
        await replyWithTracking(ctx, `Usunięto administratora ${targetId}.`, 'remove_admin:success');
    }
    else {
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
    const message = ctx.message;
    const chat = ctx.chat;
    const chatType = chat?.type;
    const isChannelContext = chatType === 'channel';
    if (!isChannelContext && !(await requireAdmin(ctx))) {
        return;
    }
    const targetFromContext = isChannelContext ? chat?.id : null;
    const forwardedId = message?.reply_to_message?.forward_from_chat?.id ??
        message?.reply_to_message?.sender_chat?.id ??
        message?.forward_from_chat?.id ??
        message?.sender_chat?.id ??
        null;
    const targetCandidate = typeof targetFromContext === 'number' ? targetFromContext : forwardedId ?? parseNumericArgument(ctx);
    if (typeof targetCandidate !== 'number') {
        await replyWithTracking(ctx, 'Nie rozpoznano ID kanału. Użyj `/set_channel <id>`, wykonaj komendę z kanału lub odpowiedz na wiadomość przekazaną z kanału.', 'set_channel:missing');
        return;
    }
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ustaw ten kanał', `setchan:${targetCandidate}`)],
    ]);
    await replyWithTracking(ctx, `Wykryto kanał o ID: ${targetCandidate}\nCzy chcesz ustawić go jako główny?`, 'set_channel:confirm_prompt', keyboard);
});
bot.command('channel_test', async (ctx) => {
    const channelId = await requireChannelId(ctx);
    if (channelId === null) {
        return;
    }
    try {
        const sent = await ctx.telegram.sendMessage(channelId, 'To jest testowy post na kanał z bota 🚀');
        messageStore.recordTelegramMessage(sent, 'channel_test');
        await replyWithTracking(ctx, `Wysłałem post na kanał (message_id: ${sent.message_id}).`, 'channel_test:confirmation');
    }
    catch (error) {
        console.error('Błąd przy wysyłaniu na kanał:', error);
        await replyWithTracking(ctx, 'Nie udało się wysłać posta na kanał. Sprawdź, czy bot jest adminem i czy kanał jest poprawnie ustawiony.', 'channel_test:error');
    }
});
bot.command('channel_test_media', async (ctx) => {
    const channelId = await requireChannelId(ctx);
    if (channelId === null) {
        return;
    }
    const replyMessage = getReplyMessage(ctx);
    if (!replyMessage) {
        return replyWithTracking(ctx, 'Aby użyć /channel_test_media, odpowiedz na wiadomość ze zdjęciem, wideo lub gifem.', 'channel_test_media:usage');
    }
    const mediaInfo = extractMediaFromMessage(replyMessage);
    if (!mediaInfo) {
        return replyWithTracking(ctx, 'Ta wiadomość nie zawiera obsługiwanego media. Wyślij zdjęcie, wideo lub gif i spróbuj ponownie.', 'channel_test_media:unsupported');
    }
    try {
        const caption = 'Testowe media na kanał 🚀';
        let sentMessage;
        if (mediaInfo.contentType === 'photo') {
            sentMessage = await ctx.telegram.sendPhoto(channelId, mediaInfo.fileId, { caption });
        }
        else if (mediaInfo.contentType === 'video') {
            sentMessage = await ctx.telegram.sendVideo(channelId, mediaInfo.fileId, { caption });
        }
        else {
            sentMessage = await ctx.telegram.sendAnimation(channelId, mediaInfo.fileId, { caption });
        }
        messageStore.recordTelegramMessage(sentMessage, 'channel_test_media');
        await replyWithTracking(ctx, 'Wysłałem testowe media na kanał ✅', 'channel_test_media:confirmation');
    }
    catch (error) {
        console.error('Nie udało się wysłać testowych mediów na kanał.', error);
        await replyWithTracking(ctx, 'Nie udało się wysłać testowych mediów na kanał. Sprawdź uprawnienia bota i spróbuj ponownie.', 'channel_test_media:error');
    }
});
bot.command('test_post', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
        return replyWithTracking(ctx, 'Brak identyfikatora czatu.', 'test_post:error');
    }
    const incomingText = ctx.message?.text ?? '';
    const customText = incomingText.replace(/^\/test_post\s*/, '').trim();
    const messageText = customText ||
        'To jest testowy post bota. Użyj /list_posts, przycisków ✏️/🗑 albo /edit_post /delete_post, aby poćwiczyć edycję i kasowanie.';
    try {
        const sentMessage = await replyWithTracking(ctx, messageText, 'test_post');
        console.log(`[test_post] Wysłano testową wiadomość, id: ${sentMessage.message_id} w czacie ${chatId}`);
        const infoMessage = [
            `Testowy post wysłany (ID: ${sentMessage.message_id}).`,
            'Teraz możesz:',
            '- wpisać /list_posts i zobaczyć post z przyciskami ✏️ Edytuj / 🗑 Usuń,',
            '- kliknąć przyciski pod tym postem,',
            '- albo użyć /edit_post <ID> Nowy tekst i /delete_post <ID>.',
        ].join('\n');
        await replyWithTracking(ctx, infoMessage, 'test_post:info');
    }
    catch (error) {
        console.error('[test_post] Nie udało się wysłać testowej wiadomości.', error);
        await replyWithTracking(ctx, 'Nie udało się wysłać testowego posta. Spróbuj ponownie.', 'test_post:error');
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
            return replyWithTracking(ctx, 'Limit musi być dodatnią liczbą całkowitą, np. /list_posts 5', 'list_posts:invalid_limit');
        }
        limit = Math.min(parsedLimit, MAX_LIST_POSTS_LIMIT);
    }
    const visibleMessages = messageStore
        .getAllMessagesForChat(chatId)
        .filter(isMessageVisibleInListPosts);
    if (visibleMessages.length === 0) {
        return replyWithTracking(ctx, 'Brak zaplanowanych ani testowych wiadomości w tym czacie.', 'list_posts:empty');
    }
    const limitedMessages = visibleMessages.slice(0, limit);
    await replyWithTracking(ctx, `Ostatnie zaplanowane lub testowe wiadomości bota w tym czacie (max ${limit}):`, 'list_posts:header');
    for (const message of limitedMessages) {
        const textPreview = message.text ? truncateText(message.text.trim(), 60) : '(brak treści)';
        const body = `ID: ${message.messageId}\nŹródło: ${message.source}\nTekst: ${textPreview}`;
        await replyWithTracking(ctx, body, 'list_posts:item', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✏️ Edytuj post', callback_data: `postedit:${message.messageId}` },
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
    await replyWithTracking(ctx, `Aktywne zadania w tym czacie (łącznie ${jobs.length}):`, 'list_jobs:header');
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
bot.command('stats', async (ctx) => {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number' || !configStore.isAdmin(userId)) {
        await replyWithTracking(ctx, 'Ta komenda jest dostępna tylko dla adminów.', 'stats:not_admin');
        return;
    }
    const allJobs = jobStore.getAllJobs();
    if (allJobs.length === 0) {
        await replyWithTracking(ctx, 'Brak aktywnych zadań. Użyj /wizard albo /schedule, żeby coś zaplanować.', 'stats:empty');
        return;
    }
    const currentChatId = ctx.chat?.id;
    const defaultChannelId = getChannelId();
    let currentChatJobs = 0;
    let defaultChannelJobs = 0;
    let otherJobs = 0;
    const hourCounts = new Map();
    const dowCounts = new Map();
    const nextRunCandidates = [];
    for (const job of allJobs) {
        if (typeof currentChatId === 'number' && job.targetChatId === currentChatId) {
            currentChatJobs += 1;
        }
        else if (defaultChannelId !== null && job.targetChatId === defaultChannelId) {
            defaultChannelJobs += 1;
        }
        else {
            otherJobs += 1;
        }
        const cronParts = job.cronExpr.trim().split(/\s+/);
        if (cronParts.length >= 6) {
            const hourField = cronParts[2];
            const dowField = cronParts[5];
            if (typeof hourField === 'string') {
                const hourKey = normalizeHourField(hourField);
                if (hourKey) {
                    incrementCounter(hourCounts, hourKey);
                }
            }
            if (typeof dowField === 'string') {
                const dowLabel = getDowLabel(dowField);
                if (dowLabel) {
                    incrementCounter(dowCounts, dowLabel);
                }
            }
        }
        nextRunCandidates.push({ job, nextRun: getNextRunFromJob(job) });
    }
    const upcomingJobs = nextRunCandidates
        .filter((candidate) => candidate.nextRun instanceof Date)
        .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime());
    const fallbackJob = allJobs[0];
    const representativeJob = upcomingJobs.length > 0 ? upcomingJobs[0] : { job: fallbackJob };
    const nextRunLabel = representativeJob.nextRun
        ? representativeJob.nextRun.toLocaleString('pl-PL', {
            timeZone: 'Europe/Warsaw',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        })
        : null;
    const lines = [
        '✨ Statystyki bota',
        `• Aktywne zadania: ${allJobs.length}`,
        `• Na ten czat: ${currentChatJobs}`,
        `• Na kanał domyślny: ${defaultChannelJobs}`,
        `• Na inne: ${otherJobs}`,
        '',
        '⏰ Rozkład godzin (HH: liczba jobów)',
    ];
    const hourEntries = Array.from(hourCounts.entries()).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (hourEntries.length === 0) {
        lines.push('• brak danych');
    }
    else {
        for (const [hour, count] of hourEntries) {
            lines.push(`• ${hour}: ${count}`);
        }
    }
    lines.push('', '🗓 Rozkład dni tygodnia (jeśli da się odczytać z CRON)');
    const dowEntries = Array.from(dowCounts.entries()).sort((a, b) => {
        const indexA = DOW_ORDER.indexOf(a[0]);
        const indexB = DOW_ORDER.indexOf(b[0]);
        if (indexA === -1 && indexB === -1) {
            return a[0].localeCompare(b[0]);
        }
        if (indexA === -1) {
            return 1;
        }
        if (indexB === -1) {
            return -1;
        }
        return indexA - indexB;
    });
    if (dowEntries.length === 0) {
        lines.push('• brak danych');
    }
    else {
        for (const [label, count] of dowEntries) {
            lines.push(`• ${label}: ${count}`);
        }
    }
    lines.push('', 'Najbliższe zadanie:');
    lines.push(`• chatId: ${representativeJob.job.targetChatId}`);
    lines.push(`• cron: ${representativeJob.job.cronExpr}`);
    if (nextRunLabel) {
        lines.push(`• następne uruchomienie: ${nextRunLabel}`);
    }
    const jobText = representativeJob.job.text?.trim();
    if (jobText) {
        lines.push(`• opis: ${truncateText(jobText, 70)}`);
    }
    else {
        lines.push(`• typ: ${describeJobContent(representativeJob.job.contentType)}`);
    }
    await replyWithTracking(ctx, lines.join('\n'), 'stats:report');
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
    let contentType = 'text';
    let fileId;
    let jobText;
    let jobEntities;
    if (isReplyTextMode) {
        if (hasProvidedMessage) {
            return replyWithTracking(ctx, 'Użyj /schedule jako reply bez dodatkowego tekstu po cronie, jeśli chcesz skopiować formatowanie z tej wiadomości.', 'schedule:reply_extra_text');
        }
        jobText = replyText;
        jobEntities = replyEntities;
    }
    else if (mediaInfo) {
        contentType = mediaInfo.contentType;
        fileId = mediaInfo.fileId;
        jobText = hasReplyText ? replyText : providedMessage;
        jobEntities = hasReplyText ? replyEntities : undefined;
    }
    else {
        jobText = providedMessage;
    }
    if (contentType === 'text' && !jobText) {
        return replyWithTracking(ctx, usageMessages.schedule, 'schedule:usage');
    }
    const targetChatId = ownerChatId;
    try {
        const jobRecord = createScheduledJob(ownerChatId, targetChatId, cronExpr, {
            contentType,
            text: jobText,
            fileId,
            entities: jobEntities,
        });
        const contentLabel = describeJobContent(jobRecord.contentType);
        return replyWithTracking(ctx, `OK, zaplanowano zadanie #${jobRecord.id} (${contentLabel}) z cron: ${cronExpr}.`, 'schedule:confirmation');
    }
    catch (e) {
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
    let contentType = 'text';
    let fileId;
    let jobText;
    let jobEntities;
    if (isReplyTextMode) {
        jobText = replyText;
        jobEntities = replyEntities;
    }
    else if (mediaInfo) {
        contentType = mediaInfo.contentType;
        fileId = mediaInfo.fileId;
        jobText = hasReplyText ? replyText : providedMessage;
        jobEntities = hasReplyText ? replyEntities : undefined;
    }
    else {
        jobText = providedMessage;
    }
    if (contentType === 'text' && !jobText) {
        return replyWithTracking(ctx, usageMessages.scheduleChannel, 'schedule_channel:usage');
    }
    try {
        const jobRecord = createScheduledJob(ownerChatId, channelId, cronExpr, {
            contentType,
            text: jobText,
            fileId,
            entities: jobEntities,
        });
        const contentLabel = describeJobContent(jobRecord.contentType);
        const replyModeNote = isReplyTextMode && hasProvidedMessage
            ? '\nTekst komendy został zignorowany; użyto wiadomości, na którą odpowiedziałeś.'
            : '';
        return replyWithTracking(ctx, `OK, zaplanowano zadanie kanałowe #${jobRecord.id} (${contentLabel}) z cron: ${cronExpr}.${replyModeNote}`, 'schedule_channel:confirmation');
    }
    catch (e) {
        return replyWithTracking(ctx, `Błąd crona: ${e?.message ?? e}`, 'schedule_channel:error');
    }
});
const DAY_OF_WEEK_MAP = {
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    sun: 0,
};
bot.command('wizard_channel', async (ctx) => {
    const replyMessage = ctx.message?.reply_to_message;
    if (!replyMessage) {
        await ctx.reply('Użyj /wizard_channel jako reply na wiadomość z postem.');
        return;
    }
    const payload = extractPayloadFromMessage(replyMessage);
    if (!payload) {
        await ctx.reply('Nie udało się odczytać treści posta. Użyj tekstu, zdjęcia, wideo lub gifa.');
        return;
    }
    const channelId = configStore.getMainChannelId();
    if (!channelId) {
        await ctx.reply('Kanał główny nie jest ustawiony. Użyj /set_channel, aby go zapisać.');
        return;
    }
    const text = ctx.message?.text?.trim() ?? '';
    const onceMatch = text.match(/^\/wizard_channel(?:@\w+)?\s+once\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/i);
    const dailyMatch = text.match(/^\/wizard_channel(?:@\w+)?\s+daily\s+(\d{1,2}:\d{2})$/i);
    const weeklyMatch = text.match(/^\/wizard_channel(?:@\w+)?\s+weekly\s+([A-Za-z]{3})\s+(\d{1,2}:\d{2})$/i);
    let cronExpr = null;
    if (onceMatch) {
        const [, datePart, timePart] = onceMatch;
        if (!datePart || !timePart) {
            await ctx.reply('Niepoprawny format daty. Użyj RRRR-MM-DD HH:MM.');
            return;
        }
        const parsed = parseDateTime(`${datePart} ${timePart}`);
        if (!parsed) {
            await ctx.reply('Niepoprawny format daty. Użyj RRRR-MM-DD HH:MM.');
            return;
        }
        cronExpr = `0 ${parsed.minute} ${parsed.hour} ${parsed.day} ${parsed.month} *`;
    }
    else if (dailyMatch) {
        const [, timePart] = dailyMatch;
        if (!timePart) {
            await ctx.reply('Niepoprawny format godziny. Użyj HH:MM.');
            return;
        }
        const parsed = parseHHMM(timePart);
        if (!parsed) {
            await ctx.reply('Niepoprawny format godziny. Użyj HH:MM.');
            return;
        }
        cronExpr = `0 ${parsed.minute} ${parsed.hour} * * *`;
    }
    else if (weeklyMatch) {
        const [, daySpec, timePart] = weeklyMatch;
        if (!daySpec || !timePart) {
            await ctx.reply('Niepoprawny format. Użyj weekly DDD HH:MM.');
            return;
        }
        const dayKey = daySpec.toLowerCase();
        const dayNumber = DAY_OF_WEEK_MAP[dayKey];
        if (typeof dayNumber !== 'number') {
            await ctx.reply('Niepoprawny dzień tygodnia. Użyj mon/tue/wed/thu/fri/sat/sun.');
            return;
        }
        const parsed = parseHHMM(timePart);
        if (!parsed) {
            await ctx.reply('Niepoprawny format godziny. Użyj HH:MM.');
            return;
        }
        cronExpr = `0 ${parsed.minute} ${parsed.hour} * * ${dayNumber}`;
    }
    else {
        await ctx.reply('Niepoprawna składnia. Użyj:\n/wizard_channel once RRRR-MM-DD HH:MM\n/wizard_channel daily HH:MM\n/wizard_channel weekly DDD HH:MM');
        return;
    }
    if (!cronExpr) {
        return;
    }
    const finalCronExpr = cronExpr;
    try {
        const ownerChatId = ctx.chat?.id;
        if (typeof ownerChatId !== 'number') {
            await ctx.reply('Nie udało się ustalić czatu.');
            return;
        }
        const jobRecord = createScheduledJob(ownerChatId, channelId, cronExpr, {
            contentType: payload.contentType,
            text: payload.text,
            entities: payload.entities,
            fileId: payload.fileId,
        });
        await ctx.reply(`OK, zaplanowano post na kanał.\nCron: <code>${cronExpr}</code>`, { parse_mode: 'HTML' });
    }
    catch (error) {
        await ctx.reply(`Nie udało się zaplanować posta: ${error?.message ?? error}`);
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
            return replyWithTracking(ctx, 'Można edytować tylko wiadomości wysłane przez tego bota. Odpowiedz na właściwą wiadomość.', 'edit_post:reply_not_bot');
        }
        const newText = text.replace(/^\/edit_post\s*/, '').trim();
        if (!newText) {
            return replyWithTracking(ctx, 'Podaj nową treść po komendzie, np. odpowiadając: /edit_post Nowa treść', 'edit_post:reply_missing_text');
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
            return replyWithTracking(ctx, 'Można usuwać tylko wiadomości wysłane przez tego bota. Odpowiedz na właściwą wiadomość.', 'delete_post:reply_not_bot');
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
        return replyWithTracking(ctx, `Nie znaleziono zadania #${jobId} w tym czacie.`, 'cancel_job:not_found');
    }
    return replyWithTracking(ctx, `Zadanie #${jobId} zostało zatrzymane.`, 'cancel_job:confirmation');
});
bot.on('callback_query', async (ctx) => {
    if (await handleWizardCallback(ctx)) {
        return;
    }
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
            await replyWithTracking(ctx, `Nie znaleziono zadania #${targetId} w tym czacie.`, 'callback_jobstop:not_found');
        }
        else {
            await replyWithTracking(ctx, `Zadanie #${targetId} zostało zatrzymane.`, 'callback_jobstop:confirmation');
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
            await replyWithTracking(ctx, `Nie znaleziono zadania #${targetId} w tym czacie.`, 'callback_jobedit:not_found');
            await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
            return;
        }
        editSessionStore.startJobSession(chatId, userId, targetId);
        await ctx.answerCbQuery('Przygotowuję edycję zadania...');
        await replyWithTracking(ctx, `Edytujemy zadanie #${targetId}. Wyślij teraz nową treść wiadomości.`, 'callback_jobedit:started');
        await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
        return;
    }
    if (action === 'postedit') {
        if (!userId) {
            await ctx.answerCbQuery('Brak użytkownika.');
            return;
        }
        if (!(await requireAdmin(ctx, { notify: false }))) {
            await ctx.answerCbQuery('Brak uprawnień admina.', { show_alert: true });
            return;
        }
        sessionStore.set(chatId, userId, { mode: 'edit_post', postId: targetId });
        await ctx.answerCbQuery('Przygotowuję edycję posta...');
        await replyWithTracking(ctx, 'Wyślij nową treść posta (tekst lub caption).', 'postedit:prompt');
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
            await replyWithTracking(ctx, `Nie znaleziono wiadomości o ID ${targetId} w tym czacie.`, 'callback_edit:not_found');
            await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
            return;
        }
        editSessionStore.startMessageSession(chatId, userId, targetId);
        await ctx.answerCbQuery('Przygotowuję edycję...');
        await replyWithTracking(ctx, `OK, edytujemy wiadomość o ID ${targetId}. Wyślij nową treść w kolejnym komunikacie.`, 'callback_edit:started');
        await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
        return;
    }
    if (action === 'rmadmin') {
        if (!(await requireAdmin(ctx, { notify: false }))) {
            await ctx.answerCbQuery('Brak uprawnień admina.', { show_alert: true });
            return;
        }
        if (!configStore.isAdmin(targetId)) {
            await ctx.answerCbQuery('Ten użytkownik nie jest adminem.');
            return;
        }
        configStore.removeAdmin(targetId);
        await ctx.answerCbQuery(`Usunięto admina: ${targetId}`);
        const adminIds = configStore.getAdminIds();
        if (adminIds.length === 0) {
            await ctx
                .editMessageText('Brak zdefiniowanych administratorów.')
                .catch(() => undefined);
            return;
        }
        const body = ['Lista adminów:', ...adminIds.map((id) => `• ${id}`)].join('\n');
        const keyboard = Markup.inlineKeyboard(adminIds.map((id) => [Markup.button.callback(`❌ Usuń ${id}`, `rmadmin:${id}`)]));
        await ctx
            .editMessageText(body, keyboard)
            .catch(() => undefined);
        return;
    }
    if (action === 'setchan') {
        if (!(await requireAdmin(ctx, { notify: false }))) {
            await ctx.answerCbQuery('Brak uprawnień admina.', { show_alert: true });
            return;
        }
        configStore.setMainChannelId(targetId);
        await ctx.answerCbQuery('Kanał ustawiony.');
        await ctx
            .editMessageText(`Kanał został ustawiony jako główny: ${targetId}`)
            .catch(() => undefined);
        return;
    }
    await ctx.answerCbQuery('Nieznana akcja.');
});
const getIncomingPostContent = (message) => {
    if (!message) {
        return null;
    }
    const text = 'text' in message && typeof message.text === 'string' ? message.text.trim() : '';
    if (text) {
        return { type: 'text', text };
    }
    const caption = 'caption' in message && typeof message.caption === 'string' ? message.caption.trim() : undefined;
    const photos = 'photo' in message ? message.photo : undefined;
    if (photos && photos.length > 0) {
        const lastPhoto = photos[photos.length - 1];
        if (lastPhoto?.file_id) {
            const captionField = caption ? { caption } : {};
            return {
                type: 'media',
                mediaType: 'photo',
                fileId: lastPhoto.file_id,
                ...captionField,
            };
        }
    }
    const video = 'video' in message ? message.video : undefined;
    if (video && video.file_id) {
        const captionField = caption ? { caption } : {};
        return {
            type: 'media',
            mediaType: 'video',
            fileId: video.file_id,
            ...captionField,
        };
    }
    const animation = 'animation' in message ? message.animation : undefined;
    if (animation && animation.file_id) {
        const captionField = caption ? { caption } : {};
        return {
            type: 'media',
            mediaType: 'animation',
            fileId: animation.file_id,
            ...captionField,
        };
    }
    return null;
};
const getMessagePlainText = (message) => {
    if (!message) {
        return undefined;
    }
    if ('text' in message && typeof message.text === 'string') {
        return message.text;
    }
    return undefined;
};
const isEditableMediaType = (type) => type === 'photo' || type === 'video' || type === 'animation';
const buildInputMedia = (mediaType, fileId, caption) => {
    const trimmedCaption = caption?.trim();
    const captionField = trimmedCaption ? { caption: trimmedCaption } : {};
    if (mediaType === 'photo') {
        return { type: 'photo', media: fileId, ...captionField };
    }
    if (mediaType === 'video') {
        return { type: 'video', media: fileId, ...captionField };
    }
    return { type: 'animation', media: fileId, ...captionField };
};
const handlePostEditSubmission = async (ctx, chatId, userId, session) => {
    const storedMessage = messageStore.get(chatId, session.postId);
    if (!storedMessage || storedMessage.deleted) {
        await replyWithTracking(ctx, 'Nie znaleziono posta do edycji.', 'postedit:not_found');
        sessionStore.clear(chatId, userId);
        return true;
    }
    const incomingContent = getIncomingPostContent(ctx.message);
    if (!incomingContent) {
        await replyWithTracking(ctx, 'Wyślij nową treść posta (tekst lub caption ze zdjęcia/wideo).', 'postedit:invalid');
        return true;
    }
    if (storedMessage.contentType === 'text') {
        if (incomingContent.type !== 'text') {
            await replyWithTracking(ctx, 'Ten post zawiera tylko tekst. Wyślij nowy tekst.', 'postedit:type_mismatch');
            return true;
        }
        const result = await tryEditBotMessage(chatId, storedMessage.messageId, incomingContent.text);
        sessionStore.clear(chatId, userId);
        if (result.success) {
            await replyWithTracking(ctx, '✔ Post zaktualizowany.', 'postedit:confirmation');
        }
        else {
            await replyWithTracking(ctx, `Nie udało się zaktualizować posta. ${result.message}`, 'postedit:error');
        }
        return true;
    }
    if (!isEditableMediaType(storedMessage.contentType)) {
        await replyWithTracking(ctx, 'Ten typ posta nie może być edytowany przez kreatora.', 'postedit:unsupported');
        sessionStore.clear(chatId, userId);
        return true;
    }
    if (incomingContent.type !== 'media' ||
        incomingContent.mediaType !== storedMessage.contentType) {
        await replyWithTracking(ctx, 'Ten post zawiera media. Wyślij zdjęcie, wideo lub gif tego samego typu wraz z caption.', 'postedit:type_mismatch');
        return true;
    }
    const media = buildInputMedia(incomingContent.mediaType, incomingContent.fileId, incomingContent.caption);
    try {
        await ctx.telegram.editMessageMedia(chatId, storedMessage.messageId, undefined, media);
        messageStore.updateContent(chatId, storedMessage.messageId, {
            text: incomingContent.caption?.trim() ?? '',
            contentType: storedMessage.contentType,
            fileId: incomingContent.fileId,
        });
        sessionStore.clear(chatId, userId);
        await replyWithTracking(ctx, '✔ Post zaktualizowany.', 'postedit:confirmation');
    }
    catch (error) {
        console.error('Nie udało się edytować posta (media).', error);
        sessionStore.clear(chatId, userId);
        await replyWithTracking(ctx, 'Nie udało się zaktualizować posta. Spróbuj ponownie.', 'postedit:error');
    }
    return true;
};
bot.on('message', async (ctx, next) => {
    if (await handleWizardText(ctx)) {
        return;
    }
    const callNext = () => (next ? next() : Promise.resolve());
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) {
        return callNext();
    }
    const postSession = sessionStore.get(chatId, userId);
    if (postSession?.mode === 'edit_post') {
        await handlePostEditSubmission(ctx, chatId, userId, postSession);
        return;
    }
    const session = editSessionStore.get(chatId, userId);
    if (!session) {
        return callNext();
    }
    const newText = getMessagePlainText(ctx.message)?.trim();
    if (!newText) {
        editSessionStore.clear(chatId, userId);
        await replyWithTracking(ctx, 'Nowa treść nie może być pusta. Sesję edycji anulowano.', 'edit_session:empty');
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
            await replyWithTracking(ctx, `Nie znaleziono zadania #${session.target.jobId} w tym czacie.`, 'edit_session_job:not_found');
            editSessionStore.clear(chatId, userId);
            return;
        }
        await replyWithTracking(ctx, `Treść zadania #${session.target.jobId} została zaktualizowana.`, 'edit_session_job:confirmation');
        editSessionStore.clear(chatId, userId);
        return;
    }
    editSessionStore.clear(chatId, userId);
});
const shutdown = async (signal) => {
    console.log(`Stopping (${signal})…`);
    try {
        await bot.stop(signal);
    }
    catch (error) {
        console.error('Błąd podczas zatrzymywania bota:', error);
    }
    process.exit(0);
};
const main = async () => {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
    await bot.launch();
    console.log('Bot działa.');
    if (isPanelEnabled) {
        console.log('START_PANEL=true – uruchamiam panel HTTP...');
        await startPanelServer();
    }
    else {
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
//# sourceMappingURL=index.js.map