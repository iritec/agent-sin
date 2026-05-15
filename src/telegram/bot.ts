import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadConfig, type AppConfig } from "../core/config.js";
import { appendEventLog } from "../core/logger.js";
import {
  type ChatProgressEvent,
  type ChatTurn,
  stripInternalControlBlocks,
} from "../core/chat-engine.js";
import type { AiImagePart, AiProgressEvent, AiProgressHandler } from "../core/ai-provider.js";
import {
  createIntentRuntime,
  renderBuildFooter,
  shouldShowBuildFooter,
  type IntentRuntime,
} from "../builder/build-flow.js";
import {
  routeConversationMessage,
  type BuildProgressReporter,
} from "../builder/conversation-router.js";
import { cleanProgressText, formatBuildProgress, progressIntervalMs } from "../builder/progress-format.js";
import {
  chunkText,
  cleanAttachmentText,
  formatAttachmentLabel,
  formatBytes,
  guessImageMimeType,
  indentAttachmentContent,
  isImageLikeFile,
  isTextLikeFile,
} from "../core/message-utils.js";
import {
  isEmptyIntentRuntime,
  loadIntentRuntimeMap,
  saveIntentRuntimeMap,
} from "../builder/intent-runtime-store.js";
import { inferLocaleFromText, l, lLines, withLocale } from "../core/i18n.js";
import { consumeUpdateBanner, scheduleUpdateCheck } from "../core/update-notifier.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_FILE_BASE = "https://api.telegram.org/file";
const POLL_TIMEOUT_SECONDS = 50;
const POLL_ERROR_DELAY_MS = 5000;
const TYPING_REFRESH_MS = 4500;
const MESSAGE_MAX = 4096;
const DRAFT_MESSAGE_MAX = 4096;
const DRAFT_PREVIEW_MAX = 1800;
const TELEGRAM_CONTEXT_HISTORY_LIMIT = 20;
const ATTACHMENT_TEXT_MAX_BYTES = 96 * 1024;
const ATTACHMENT_TEXT_MAX_CHARS = 20_000;
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_SUMMARY_LIMIT = 8;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramSendOptions {
  threadId?: number;
  replyToMessageId?: number;
}

export interface TelegramMessageContext {
  isPrivate: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  isAllowed: boolean;
  isListenChat: boolean;
}

export interface TelegramIdentityCandidate {
  updateId: number;
  userId: string;
  chatId: string;
  chatType: TelegramChat["type"];
  displayName: string;
  username?: string;
}

interface TelegramBotState {
  config: AppConfig;
  token: string;
  allowedUserIds: Set<string>;
  listenChatIds: Set<string>;
  botUserId: string | null;
  botUsername: string | null;
  histories: Map<string, ChatTurn[]>;
  historiesFile: string;
  intentRuntimes: Map<string, IntentRuntime>;
  intentRuntimesFile: string;
  offset: number | null;
  offsetFile: string;
  running: boolean;
}

interface TelegramDraftStreamer {
  update(text: string, options?: { force?: boolean }): void;
  onChatProgress(event: ChatProgressEvent): void;
  onAiProgress(event: AiProgressEvent): void;
  onBuildProgress(event: AiProgressEvent): void;
  finish(): Promise<void>;
}

export async function runTelegramBot(config: AppConfig): Promise<number> {
  const token = (process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    console.error("AGENT_SIN_TELEGRAM_BOT_TOKEN is not set. Add it to ~/.agent-sin/.env or export it.");
    return 1;
  }
  const allowedRaw = process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS || "";
  const allowedUserIds = parseTelegramIdList(allowedRaw);
  if (allowedUserIds.size === 0) {
    console.error(
      "AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS is empty. Set it to your Telegram user ID so the bot only replies to you.",
    );
    return 1;
  }

  const listenChatIds = parseTelegramIdList(process.env.AGENT_SIN_TELEGRAM_LISTEN_CHAT_IDS || "");
  const offsetFile = path.join(config.workspace, "telegram", "offset.json");
  const intentRuntimesFile = path.join(config.workspace, "telegram", "intent-runtimes.json");
  const historiesFile = path.join(config.workspace, "telegram", "histories.json");
  const persistedIntentRuntimes = await loadTelegramIntentRuntimes(intentRuntimesFile);
  const persistedHistories = await loadTelegramHistories(historiesFile);
  const offset = await loadTelegramOffset(offsetFile);

  const state: TelegramBotState = {
    config,
    token,
    allowedUserIds,
    listenChatIds,
    botUserId: null,
    botUsername: null,
    histories: persistedHistories,
    historiesFile,
    intentRuntimes: persistedIntentRuntimes,
    intentRuntimesFile,
    offset,
    offsetFile,
    running: true,
  };

  const shutdown = () => {
    state.running = false;
    console.log("agent-sin telegram: shutting down");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  scheduleUpdateCheck(config.workspace);

  let me: TelegramUser;
  try {
    me = await telegramApi<TelegramUser>(state, "getMe", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin telegram: getMe failed: ${message}`);
    await appendEventLog(config, { level: "error", source: "telegram", event: "get_me_failed", message });
    return 1;
  }
  state.botUserId = String(me.id);
  state.botUsername = me.username || null;

  if (state.offset === null) {
    await skipPendingUpdates(state);
  }

  await appendEventLog(config, {
    level: "info",
    source: "telegram",
    event: "bot_starting",
    details: {
      allowed_user_count: allowedUserIds.size,
      listen_chat_count: listenChatIds.size,
      bot_user_id: state.botUserId,
      bot_username: state.botUsername,
    },
  });
  console.log(
    `agent-sin telegram: starting as @${state.botUsername || "unknown"} (allowed users: ${allowedUserIds.size}, listen chats: ${listenChatIds.size})`,
  );

  while (state.running) {
    try {
      const updates = await getTelegramUpdates(state, POLL_TIMEOUT_SECONDS);
      for (const update of updates) {
        if (!state.running) break;
        if (typeof update.update_id === "number") {
          state.offset = update.update_id + 1;
        }
        if (update.message) {
          await handleTelegramMessage(state, update.message);
        }
        await saveTelegramOffset(state);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin telegram: polling error: ${message}`);
      await appendEventLog(config, {
        level: "error",
        source: "telegram",
        event: "polling_error",
        message,
      });
      if (state.running) {
        await sleep(POLL_ERROR_DELAY_MS);
      }
    }
  }
  await appendEventLog(config, { level: "info", source: "telegram", event: "bot_stopped" });
  return 0;
}

export function parseTelegramIdList(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const trimmed = part.trim();
    if (trimmed && /^-?\d+$/.test(trimmed)) {
      ids.add(trimmed);
    }
  }
  return ids;
}

export function classifyTelegramMessage(
  message: TelegramMessage,
  botUserId: string | null,
  botUsername: string | null,
  allowedUserIds: Set<string>,
  listenChatIds: Set<string> = new Set(),
): TelegramMessageContext {
  const isPrivate = message.chat?.type === "private";
  const isMentioned = hasTelegramBotMention(message, botUserId, botUsername);
  const isReplyToBot = Boolean(
    botUserId && message.reply_to_message?.from && String(message.reply_to_message.from.id) === botUserId,
  );
  const isAllowed = Boolean(message.from && allowedUserIds.has(String(message.from.id)));
  const isListenChat = Boolean(message.chat && listenChatIds.has(String(message.chat.id)));
  return { isPrivate, isMentioned, isReplyToBot, isAllowed, isListenChat };
}

export function shouldRespond(ctx: TelegramMessageContext): boolean {
  if (!ctx.isAllowed) return false;
  return ctx.isPrivate || ctx.isMentioned || ctx.isReplyToBot;
}

export function extractTelegramIdentityCandidates(updates: TelegramUpdate[]): TelegramIdentityCandidate[] {
  const byUserId = new Map<string, TelegramIdentityCandidate>();
  for (const update of updates) {
    const message = update.message;
    const user = message?.from;
    if (!message || !user || user.is_bot) {
      continue;
    }
    const userId = String(user.id);
    const displayName = [user.first_name, user.username ? `@${user.username}` : ""].filter(Boolean).join(" ");
    const candidate: TelegramIdentityCandidate = {
      updateId: update.update_id,
      userId,
      chatId: String(message.chat.id),
      chatType: message.chat.type,
      displayName: displayName || userId,
      username: user.username,
    };
    const existing = byUserId.get(userId);
    if (!existing || (existing.chatType !== "private" && candidate.chatType === "private")) {
      byUserId.set(userId, candidate);
    }
  }
  return [...byUserId.values()].sort((a, b) => {
    if (a.chatType === "private" && b.chatType !== "private") return -1;
    if (a.chatType !== "private" && b.chatType === "private") return 1;
    return b.updateId - a.updateId;
  });
}

export function telegramChatKey(message: TelegramMessage): string {
  return `${message.chat.id}:${message.message_thread_id || 0}`;
}

export function stripTelegramBotMention(content: string, botUsername: string | null): string {
  const trimmed = content.trim();
  if (!botUsername) {
    return trimmed;
  }
  const username = botUsername.replace(/^@/, "");
  return trimmed
    .replace(new RegExp(`@${escapeRegExp(username)}\\b`, "gi"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function formatTelegramUserMessageForHistory(
  message: TelegramMessage,
  botUsername: string | null,
  botUserId: string | null = null,
): string {
  const text = stripTelegramBotMention(messageText(message), botUsername);
  const attachments = formatTelegramAttachmentSummary(message);
  const replyContext = formatTelegramReplyContext(message, botUsername, botUserId);
  return [replyContext, text, attachments].filter(Boolean).join("\n\n").trim();
}

export function formatTelegramReplyContext(
  message: TelegramMessage,
  botUsername: string | null,
  botUserId: string | null,
): string {
  const reply = message.reply_to_message;
  if (!reply) return "";
  const rawText = stripTelegramBotMention(messageText(reply), botUsername);
  const attachmentSummary = formatTelegramAttachmentSummary(reply);
  const body = [rawText, attachmentSummary].filter(Boolean).join("\n").trim();
  if (!body) return "";
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const author = formatTelegramReplyAuthor(reply, botUserId);
  return l(`[Reply to: ${author}]\n${quoted}`, `[返信元: ${author}]\n${quoted}`);
}

function formatTelegramReplyAuthor(message: TelegramMessage, botUserId: string | null): string {
  const from = message.from;
  if (!from) return l("unknown", "不明");
  if (botUserId && String(from.id) === botUserId) return l("me (bot)", "自分(bot)");
  if (from.is_bot) return from.first_name || from.username || "bot";
  return from.first_name || from.username || String(from.id);
}

export function buildChatHistoryFromTelegramMessages(
  messages: TelegramMessage[],
  botUserId: string | null,
  botUsername: string | null,
  allowedUserIds: Set<string>,
): ChatTurn[] {
  const history: ChatTurn[] = [];
  for (const message of messages) {
    if (message.from?.is_bot) {
      if (!botUserId || String(message.from.id) !== botUserId) continue;
      const stripped = stripBadgePrefix(messageText(message)).trim();
      if (stripped) history.push({ role: "assistant", content: stripped });
      continue;
    }
    if (allowedUserIds.size > 0 && (!message.from || !allowedUserIds.has(String(message.from.id)))) continue;
    const cleaned = formatTelegramUserMessageForHistory(message, botUsername, botUserId);
    if (cleaned) history.push({ role: "user", content: cleaned });
  }
  return history.slice(-TELEGRAM_CONTEXT_HISTORY_LIMIT);
}

export function chunkTelegramMessage(text: string, max: number = MESSAGE_MAX): string[] {
  return chunkText(text, max);
}

async function skipPendingUpdates(state: TelegramBotState): Promise<void> {
  const updates = await getTelegramUpdates(state, 0);
  const maxUpdateId = updates.reduce((max, update) => Math.max(max, update.update_id), -1);
  state.offset = maxUpdateId >= 0 ? maxUpdateId + 1 : 0;
  await saveTelegramOffset(state);
  if (updates.length > 0) {
    await appendEventLog(state.config, {
      level: "info",
      source: "telegram",
      event: "pending_updates_skipped",
      details: { count: updates.length },
    });
  }
}

async function getTelegramUpdates(state: TelegramBotState, timeoutSeconds: number): Promise<TelegramUpdate[]> {
  const payload: Record<string, unknown> = {
    timeout: timeoutSeconds,
    allowed_updates: ["message"],
  };
  if (state.offset !== null) {
    payload.offset = state.offset;
  }
  const updates = await telegramApi<TelegramUpdate[]>(state, "getUpdates", payload);
  return Array.isArray(updates) ? updates : [];
}

async function handleTelegramMessage(state: TelegramBotState, message: TelegramMessage): Promise<void> {
  if (!message || !message.chat || !message.from || message.from.is_bot) {
    return;
  }
  const ctx = classifyTelegramMessage(
    message,
    state.botUserId,
    state.botUsername,
    state.allowedUserIds,
    state.listenChatIds,
  );
  if (!shouldRespond(ctx)) {
    if ((ctx.isPrivate || ctx.isMentioned || ctx.isReplyToBot) && !ctx.isAllowed) {
      await appendEventLog(state.config, {
        level: "warn",
        source: "telegram",
        event: "blocked_user",
        details: { user_id: message.from.id, chat_id: message.chat.id },
      });
    } else if (ctx.isPrivate || ctx.isMentioned || ctx.isReplyToBot || ctx.isListenChat) {
      await appendEventLog(state.config, {
        level: "info",
        source: "telegram",
        event: "message_ignored",
        message: messageText(message).slice(0, 120),
        details: {
          chat_id: message.chat.id,
          message_id: message.message_id,
          author_id: message.from.id,
          is_private: ctx.isPrivate,
          is_mentioned: ctx.isMentioned,
          is_reply_to_bot: ctx.isReplyToBot,
          is_allowed: ctx.isAllowed,
          is_listen_chat: ctx.isListenChat,
        },
      });
    }
    return;
  }

  const cleanText = normalizeTelegramCommand(
    stripTelegramBotMention(messageText(message), state.botUsername),
    state.botUsername,
  );
  const chatKey = telegramChatKey(message);
  const chatId = String(message.chat.id);
  const threadId = message.message_thread_id;
  const sendOptions: TelegramSendOptions = { threadId, replyToMessageId: message.message_id };

  if (cleanText === "!help" || cleanText === "/help" || cleanText === "/start") {
    await sendTelegramMessage(state, chatId, helpText(), sendOptions);
    return;
  }
  if (cleanText === "!reset" || cleanText === "/reset") {
    if (state.histories.delete(chatKey)) {
      void saveTelegramHistories(state);
    }
    if (state.intentRuntimes.delete(chatKey)) {
      void saveTelegramIntentRuntimes(state);
    }
    await sendTelegramMessage(state, chatId, l("Chat history reset.", "会話履歴をリセットしました。"), sendOptions);
    return;
  }
  const progressCommand = handleProgressCommand(state, chatKey, cleanText);
  if (progressCommand) {
    await sendTelegramMessage(state, chatId, progressCommand.join("\n"), sendOptions);
    return;
  }

  const userMessage = await formatTelegramUserMessageForChat(state, message);
  const userText = normalizeTelegramCommand(userMessage.text, state.botUsername);
  if (!userText) {
    await sendTelegramMessage(state, chatId, l("Please enter a message. Use `/help` for usage.", "メッセージを入力してください。`/help` で使い方を表示します。"), sendOptions);
    return;
  }

  let history = state.histories.get(chatKey);
  if (!history) {
    history = [];
    state.histories.set(chatKey, history);
  }

  let intentRuntime = state.intentRuntimes.get(chatKey);
  if (!intentRuntime) {
    intentRuntime = createIntentRuntime(true);
    state.intentRuntimes.set(chatKey, intentRuntime);
  }

  await refreshTelegramStateConfig(state);

  await withLocale(inferLocaleFromText(userText), async () => {
    const typing = startTypingKeepalive(state, chatId, threadId);
    const draft = createTelegramDraftStreamer(state, message);
    draft.update(l("Thinking", "考えています"), { force: true });
    const prevMode = intentRuntime.mode;
    try {
      const lines = await routeTelegramMessage(
        state,
        userText,
        history,
        intentRuntime,
        chatKey,
        chatId,
        threadId,
        message.message_id,
        draft,
        userMessage.images,
      );
      typing.stop();
      trimHistory(history);
      void saveTelegramHistories(state);
      void saveTelegramIntentRuntimes(state);
      const isBuildEntry = prevMode !== "build" && intentRuntime.mode === "build";
      const decorated = withTelegramModeBadge(intentRuntime, lines, { userText, isBuildEntry });
      scheduleUpdateCheck(state.config.workspace);
      const banner = await consumeUpdateBanner(state.config.workspace);
      const finalLines = banner ? [banner, "", ...decorated] : decorated;
      const reply = finalLines.filter((line) => line !== undefined && line !== null).join("\n").trim();
      draft.update(l("Sending reply", "応答を送信しています"), { force: true });
      await draft.finish();
      await sendTelegramMessage(state, chatId, reply || l("(no response)", "（応答なし）"), sendOptions);
    } catch (error) {
      typing.stop();
      draft.update(l("Error occurred", "エラーになりました"), { force: true });
      await draft.finish();
      const errMessage = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin telegram: routeTelegramMessage failed: ${errMessage}`);
      await appendEventLog(state.config, {
        level: "error",
        source: "telegram",
        event: "route_failed",
        message: errMessage.slice(0, 200),
        details: { chat_id: chatId, message_id: message.message_id },
      });
      await sendTelegramMessage(state, chatId, l(`Error: ${errMessage}`, `エラー: ${errMessage}`), sendOptions);
    }
  });
}

async function refreshTelegramStateConfig(state: TelegramBotState): Promise<void> {
  try {
    state.config = await loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "telegram",
      event: "config_refresh_failed",
      message,
    });
  }
}

async function routeTelegramMessage(
  state: TelegramBotState,
  text: string,
  history: ChatTurn[],
  intentRuntime: IntentRuntime,
  chatKey: string,
  chatId: string,
  threadId: number | undefined,
  replyToMessageId: number,
  draft: TelegramDraftStreamer,
  images: AiImagePart[] = [],
): Promise<string[]> {
  return routeConversationMessage({
    config: state.config,
    text,
    history,
    intentRuntime,
    eventSource: "telegram",
    images,
    createBuildProgress: () =>
      createTelegramBuildProgressReporter(state, chatKey, chatId, threadId, replyToMessageId, draft),
    onChatProgress: (event) => draft.onChatProgress(event),
    onAiProgress: (event) => draft.onAiProgress(event),
  });
}

function createTelegramBuildProgressReporter(
  state: TelegramBotState,
  chatKey: string,
  chatId: string,
  threadId: number | undefined,
  replyToMessageId: number,
  draft: TelegramDraftStreamer,
): BuildProgressReporter {
  const minIntervalMs = telegramProgressIntervalMs();
  let lastSentAt = 0;
  let lastText = "";
  let sent = 0;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (text: string): void => {
    pending = pending
      .then(async () => {
        await sendTelegramMessage(state, chatId, text, { threadId, replyToMessageId });
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await appendEventLog(state.config, {
          level: "warn",
          source: "telegram",
          event: "build_progress_failed",
          message: message.slice(0, 200),
          details: { chat_id: chatId },
        });
      });
  };

  return {
    onProgress(event: AiProgressEvent): void {
      draft.onBuildProgress(event);
      const text = formatTelegramBuildProgress(event, {
        detail: isTelegramProgressDetailEnabled(state, chatKey),
      });
      if (!text) {
        return;
      }
      const now = Date.now();
      if (text === lastText) {
        return;
      }
      if (sent > 0 && now - lastSentAt < minIntervalMs) {
        return;
      }
      lastText = text;
      lastSentAt = now;
      sent += 1;
      enqueue(text);
    },
    async flush(): Promise<void> {
      await pending;
    },
  };
}

function isTelegramProgressDetailEnabled(state: TelegramBotState, chatKey: string): boolean {
  if (process.env.AGENT_SIN_TELEGRAM_PROGRESS_DETAIL === "1") {
    return true;
  }
  return state.intentRuntimes.get(chatKey)?.progress_detail === true;
}

function telegramProgressIntervalMs(): number {
  return progressIntervalMs("AGENT_SIN_TELEGRAM_PROGRESS_INTERVAL_MS");
}

export function formatTelegramBuildProgress(
  event: AiProgressEvent,
  options: { detail?: boolean } = {},
): string | null {
  return formatBuildProgress(event, options);
}

function withTelegramModeBadge(
  intentRuntime: IntentRuntime,
  lines: string[],
  options: { userText?: string; isBuildEntry?: boolean } = {},
): string[] {
  if (!shouldShowBuildFooter({
    intentRuntime,
    userText: options.userText ?? "",
    replyLines: lines,
    isBuildEntry: options.isBuildEntry ?? false,
  })) {
    return lines;
  }
  const footer = renderBuildFooter(intentRuntime, {
    exitPrefix: "/",
    languageHint: [options.userText ?? "", ...lines],
  });
  if (!footer) return lines;
  return [...lines, "", footer];
}

function handleProgressCommand(state: TelegramBotState, chatKey: string, text: string): string[] | null {
  if (
    text !== "!progress" &&
    !text.startsWith("!progress ") &&
    text !== "/progress" &&
    !text.startsWith("/progress ")
  ) {
    return null;
  }
  const mode = text.trim().split(/\s+/)[1]?.toLowerCase() || "status";
  const current = state.intentRuntimes.get(chatKey);
  if (["detail", "detailed", "verbose", "on"].includes(mode)) {
    const runtime = current || createIntentRuntime(true);
    runtime.progress_detail = true;
    state.intentRuntimes.set(chatKey, runtime);
    void saveTelegramIntentRuntimes(state);
    return [l("Progress details are enabled for this chat. Use `/progress quiet` to switch back.", "このチャットの進捗通知を詳細表示にしました。`/progress quiet` で戻せます。")];
  }
  if (["quiet", "summary", "off"].includes(mode)) {
    const runtime = current || createIntentRuntime(true);
    runtime.progress_detail = false;
    if (isEmptyIntentRuntime(runtime)) {
      state.intentRuntimes.delete(chatKey);
    } else {
      state.intentRuntimes.set(chatKey, runtime);
    }
    void saveTelegramIntentRuntimes(state);
    return [l("Progress is now quiet for this chat. Internal logs will not be sent to Telegram.", "このチャットの進捗通知を静音表示にしました。内部ログはTelegramに流しません。")];
  }
  if (mode === "status") {
    return [
      current?.progress_detail
        ? l("Progress details are enabled for this chat.", "このチャットの進捗通知は詳細表示です。")
        : l("Progress is quiet for this chat.", "このチャットの進捗通知は静音表示です。"),
    ];
  }
  return [l("Usage: /progress status | quiet | detail", "使い方: /progress status | quiet | detail")];
}

function helpText(): string {
  return lLines(
    [
      "Welcome to the Agent-Sin Telegram bot.",
      "It responds in DMs, mentions, and replies to the bot. Registered skills are called automatically when useful.",
    ],
    [
      "Agent-Sin Telegram bot へようこそ。",
      "DM、メンション、bot への返信に反応します。登録済みスキルも自動で呼び出されます。",
    ],
  ).join("\n");
}

async function formatTelegramUserMessageForChat(
  state: TelegramBotState,
  message: TelegramMessage,
): Promise<{ text: string; images: AiImagePart[] }> {
  const text = stripTelegramBotMention(messageText(message), state.botUsername);
  const attachments = await formatTelegramAttachmentDetails(state, message);
  const replyContext = formatTelegramReplyContext(message, state.botUsername, state.botUserId);
  return {
    text: [replyContext, text, attachments.text].filter(Boolean).join("\n\n").trim(),
    images: attachments.images,
  };
}

function formatTelegramAttachmentSummary(message: TelegramMessage): string {
  const normalized = normalizeTelegramAttachments(message);
  if (normalized.length === 0) {
    return "";
  }
  const shown = normalized.slice(0, ATTACHMENT_SUMMARY_LIMIT);
  const lines = [l("[Telegram attachments]", "[Telegram添付]")];
  shown.forEach((attachment, index) => {
    lines.push(`${index + 1}. ${formatTelegramAttachmentLabel(attachment)}`);
  });
  if (normalized.length > shown.length) {
    lines.push(l(`...and ${normalized.length - shown.length} more`, `...他 ${normalized.length - shown.length} 件`));
  }
  return lines.join("\n");
}

async function formatTelegramAttachmentDetails(
  state: TelegramBotState,
  message: TelegramMessage,
): Promise<{ text: string; images: AiImagePart[] }> {
  const normalized = normalizeTelegramAttachments(message);
  if (normalized.length === 0) {
    return { text: "", images: [] };
  }
  const shown = normalized.slice(0, ATTACHMENT_SUMMARY_LIMIT);
  const lines = [l("[Telegram attachments]", "[Telegram添付]")];
  const images: AiImagePart[] = [];
  for (let index = 0; index < shown.length; index += 1) {
    const attachment = shown[index];
    lines.push(`${index + 1}. ${formatTelegramAttachmentLabel(attachment)}`);
    if (attachment.kind === "photo" || isImageTelegramDocument(attachment)) {
      const image = await readTelegramAttachmentImage(state, attachment);
      if (image.kind === "image") {
        images.push(image.part);
        if (image.savedPath) {
          lines.push(l(`   Content: image attached as AI input. Saved at: ${image.savedPath}`, `   内容: 画像を AI 入力として添付しました。保存先: ${image.savedPath}`));
          lines.push(l(`   To keep this image in a saving skill such as memo-save, reference this path as Markdown: ![](${image.savedPath})`, `   memo-saveなど保存系スキルで本文に画像を残すときは、Markdown記法 ![](${image.savedPath}) でこのパスを参照してください。`));
        } else {
          lines.push(l("   Content: image attached as AI input.", "   内容: 画像を AI 入力として添付しました。"));
        }
      } else if (image.reason) {
        lines.push(l(`   Content: ${image.reason}`, `   内容: ${image.reason}`));
      }
    } else {
      const content = await readTelegramAttachmentText(state, attachment);
      if (content.kind === "text") {
        lines.push(l("   Content:", "   内容:"));
        lines.push(indentAttachmentContent(content.text));
      } else if (content.reason) {
        lines.push(l(`   Content: ${content.reason}`, `   内容: ${content.reason}`));
      }
    }
  }
  if (normalized.length > shown.length) {
    lines.push(l(`...and ${normalized.length - shown.length} more`, `...他 ${normalized.length - shown.length} 件`));
  }
  return { text: lines.join("\n"), images };
}

type TelegramAttachment =
  | { kind: "photo"; file_id: string; file_size?: number; filename?: string; mime_type?: string }
  | { kind: "document"; file_id: string; file_size?: number; filename?: string; mime_type?: string };

function normalizeTelegramAttachments(message: TelegramMessage): TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = [...message.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
    if (photo?.file_id) {
      attachments.push({
        kind: "photo",
        file_id: photo.file_id,
        file_size: photo.file_size,
        filename: "photo.jpg",
        mime_type: "image/jpeg",
      });
    }
  }
  if (message.document?.file_id) {
    attachments.push({
      kind: "document",
      file_id: message.document.file_id,
      file_size: message.document.file_size,
      filename: message.document.file_name,
      mime_type: message.document.mime_type,
    });
  }
  return attachments;
}

function formatTelegramAttachmentLabel(attachment: TelegramAttachment): string {
  return formatAttachmentLabel({
    name: attachment.filename,
    fallback: attachment.kind === "photo" ? l("photo", "写真") : l("attachment", "添付ファイル"),
    contentType: attachment.mime_type,
    size: attachment.file_size,
  });
}

async function readTelegramAttachmentText(
  state: TelegramBotState,
  attachment: TelegramAttachment,
): Promise<{ kind: "text"; text: string } | { kind: "skipped"; reason?: string }> {
  if (!isTextLikeTelegramDocument(attachment)) {
    return { kind: "skipped", reason: l("This file type is not auto-extracted.", "この形式は本文を自動抽出していません。") };
  }
  if (typeof attachment.file_size === "number" && attachment.file_size > ATTACHMENT_TEXT_MAX_BYTES) {
    return {
      kind: "skipped",
      reason: l(`Text attachment is too large and was skipped (${formatBytes(attachment.file_size)}).`, `テキスト添付が大きすぎるため読み取りを省略しました（${formatBytes(attachment.file_size)}）。`),
    };
  }
  try {
    const buffer = await fetchTelegramFileBuffer(state, attachment.file_id, ATTACHMENT_TEXT_MAX_BYTES);
    const text = cleanAttachmentText(buffer.toString("utf8"), ATTACHMENT_TEXT_MAX_CHARS);
    if (!text) {
      return { kind: "skipped", reason: l("The text body was empty.", "本文が空でした。") };
    }
    return { kind: "text", text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "telegram",
      event: "attachment_read_failed",
      message: message.slice(0, 200),
      details: {
        filename: attachment.filename,
        mime_type: attachment.mime_type,
      },
    });
    return { kind: "skipped", reason: l("An error occurred while fetching text.", "本文取得でエラーになりました。") };
  }
}

async function readTelegramAttachmentImage(
  state: TelegramBotState,
  attachment: TelegramAttachment,
): Promise<
  | { kind: "image"; part: AiImagePart; savedPath?: string }
  | { kind: "skipped"; reason?: string }
> {
  if (typeof attachment.file_size === "number" && attachment.file_size > ATTACHMENT_IMAGE_MAX_BYTES) {
    return {
      kind: "skipped",
      reason: l(`Image is too large and was skipped (${formatBytes(attachment.file_size)}).`, `画像が大きすぎるため添付を省略しました（${formatBytes(attachment.file_size)}）。`),
    };
  }
  try {
    const buffer = await fetchTelegramFileBuffer(state, attachment.file_id, ATTACHMENT_IMAGE_MAX_BYTES);
    const mimeType = attachment.mime_type || guessImageMimeType(attachment.filename || "");
    const savedPath = await persistTelegramAttachmentBuffer(state, attachment, buffer, mimeType);
    return {
      kind: "image",
      part: {
        type: "image",
        image_url: `data:${mimeType};base64,${buffer.toString("base64")}`,
        mime_type: mimeType,
        filename: attachment.filename,
      },
      savedPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "telegram",
      event: "attachment_image_read_failed",
      message: message.slice(0, 200),
      details: {
        filename: attachment.filename,
        mime_type: attachment.mime_type,
      },
    });
    return { kind: "skipped", reason: l("An error occurred while fetching the image.", "画像取得でエラーになりました。") };
  }
}

async function persistTelegramAttachmentBuffer(
  state: TelegramBotState,
  attachment: TelegramAttachment,
  buffer: Buffer,
  mimeType: string,
): Promise<string | undefined> {
  try {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const MM = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const HH = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const dir = path.join(state.config.notes_dir, "attachments", yyyy, MM);
    await mkdir(dir, { recursive: true });
    const ext = pickAttachmentExtension(attachment.filename, mimeType);
    const random = Math.random().toString(36).slice(2, 8);
    const filename = `${yyyy}${MM}${dd}-${HH}${mm}${ss}-${random}${ext}`;
    const fullPath = path.join(dir, filename);
    await writeFile(fullPath, buffer);
    return fullPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "telegram",
      event: "attachment_persist_failed",
      message: message.slice(0, 200),
      details: {
        filename: attachment.filename,
        mime_type: attachment.mime_type,
      },
    });
    return undefined;
  }
}

function pickAttachmentExtension(filename: string | undefined, mimeType: string): string {
  if (filename) {
    const ext = path.extname(filename);
    if (ext && ext.length <= 8) {
      return ext.toLowerCase();
    }
  }
  const fromMime = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  if (fromMime) {
    if (fromMime === "jpeg") return ".jpg";
    if (/^[a-z0-9]{1,6}$/.test(fromMime)) {
      return `.${fromMime}`;
    }
  }
  return ".bin";
}

async function fetchTelegramFileBuffer(
  state: TelegramBotState,
  fileId: string,
  maxBytes: number,
): Promise<Buffer> {
  const file = await telegramApi<TelegramFile>(state, "getFile", { file_id: fileId });
  if (!file.file_path) {
    throw new Error("file_path is missing");
  }
  if (typeof file.file_size === "number" && file.file_size > maxBytes) {
    throw new Error(`file too large: ${formatBytes(file.file_size)}`);
  }
  const response = await fetch(`${TELEGRAM_FILE_BASE}/bot${state.token}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const length = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`file too large: ${formatBytes(length)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`file too large: ${formatBytes(buffer.length)}`);
  }
  return buffer;
}

function isTextLikeTelegramDocument(attachment: TelegramAttachment): boolean {
  if (attachment.kind !== "document") {
    return false;
  }
  return isTextLikeFile(attachment.mime_type, attachment.filename);
}

function isImageTelegramDocument(attachment: TelegramAttachment): boolean {
  if (attachment.kind === "photo") {
    return true;
  }
  return isImageLikeFile(attachment.mime_type, attachment.filename);
}

function messageText(message: TelegramMessage): string {
  return (message.text || message.caption || "").trim();
}

function messageEntities(message: TelegramMessage): TelegramMessageEntity[] {
  return [...(message.entities || []), ...(message.caption_entities || [])];
}

function hasTelegramBotMention(
  message: TelegramMessage,
  botUserId: string | null,
  botUsername: string | null,
): boolean {
  const text = messageText(message);
  const username = botUsername ? botUsername.replace(/^@/, "").toLowerCase() : "";
  for (const entity of messageEntities(message)) {
    if (entity.type === "text_mention" && botUserId && entity.user && String(entity.user.id) === botUserId) {
      return true;
    }
    if (entity.type === "mention" && username) {
      const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mention === `@${username}`) {
        return true;
      }
    }
  }
  if (!username) {
    return false;
  }
  return new RegExp(`(^|\\s)@${escapeRegExp(username)}\\b`, "i").test(text);
}

function normalizeTelegramCommand(text: string, botUsername: string | null): string {
  const trimmed = text.trim();
  if (!botUsername) {
    return trimmed;
  }
  const username = botUsername.replace(/^@/, "");
  return trimmed.replace(new RegExp(`^/(\\w+)@${escapeRegExp(username)}\\b`, "i"), "/$1").trim();
}

const BADGE_PREFIX_PATTERN = /^(💬|🔧|✏️|✏)/u;
const BUILD_FOOTER_FIRST_LINE =
  /^(?:(?:✏️|✏|🔧)\s*現在ビルドモードです|（(?:現在：「[^」]*」の)?ビルドモード(?:です。抜けるには|を抜けるには)\s*\/back\s*と返事してください）)\s*$/u;

function stripBadgePrefix(content: string): string {
  if (!content) return "";
  let lines = content.split("\n");
  if (lines.length > 0 && BADGE_PREFIX_PATTERN.test(lines[0].trim())) {
    let i = 1;
    for (; i < Math.min(lines.length, 5); i += 1) {
      if (lines[i].trim() === "----") {
        i += 1;
        break;
      }
    }
    lines = lines.slice(i);
  }
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (BUILD_FOOTER_FIRST_LINE.test(lines[j].trim())) {
      let cut = j;
      while (cut > 0 && lines[cut - 1].trim() === "") cut -= 1;
      lines = lines.slice(0, cut);
      break;
    }
  }
  return lines.join("\n").trim();
}

export function shouldUseTelegramDraftStream(message: TelegramMessage): boolean {
  if (process.env.AGENT_SIN_TELEGRAM_DRAFT_STREAM === "0") {
    return false;
  }
  return message.chat?.type === "private" && Number.isSafeInteger(message.chat.id);
}

export function telegramSendPayload(
  chatId: string,
  content: string,
  options: TelegramSendOptions = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: content,
    disable_web_page_preview: true,
  };
  if (options.threadId) {
    payload.message_thread_id = options.threadId;
  }
  if (options.replyToMessageId && process.env.AGENT_SIN_TELEGRAM_REPLY_TO_MESSAGE !== "0") {
    payload.reply_parameters = {
      message_id: options.replyToMessageId,
      allow_sending_without_reply: true,
    };
  }
  return payload;
}

export function telegramDraftPayload(
  message: TelegramMessage,
  draftId: number,
  text: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    chat_id: message.chat.id,
    draft_id: draftId,
    text: cleanDraftText(text),
  };
  if (message.message_thread_id) {
    payload.message_thread_id = message.message_thread_id;
  }
  return payload;
}

export function formatTelegramDraftProgress(event: AiProgressEvent): string | null {
  switch (event.kind) {
    case "message":
      return event.text ? cleanDraftText(event.text) : null;
    case "thinking": {
      const detail = cleanProgressText(event.text || "");
      return detail ? l(`Thinking: ${detail}`, `考えています: ${detail}`) : l("Thinking", "考えています");
    }
    case "tool": {
      const name = cleanProgressText(event.name || "");
      return name ? l(`Running tool: ${name}`, `ツール実行中: ${name}`) : l("Running tool", "ツール実行中");
    }
    case "info": {
      const detail = cleanProgressText(event.text || "");
      return detail || null;
    }
    case "stderr":
      return l("Checking tool output", "ツール出力を確認中");
    default:
      return null;
  }
}

function createTelegramDraftStreamer(state: TelegramBotState, message: TelegramMessage): TelegramDraftStreamer {
  if (!shouldUseTelegramDraftStream(message)) {
    return noopTelegramDraftStreamer();
  }
  const draftId = createTelegramDraftId();
  const minIntervalMs = telegramDraftIntervalMs();
  let lastSentAt = 0;
  let lastText = "";
  let disabled = false;
  let warningLogged = false;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (text: string, force = false): void => {
    if (disabled) return;
    const cleaned = cleanDraftText(text);
    if (!cleaned || cleaned === lastText) return;
    const now = Date.now();
    if (!force && lastSentAt > 0 && now - lastSentAt < minIntervalMs) {
      return;
    }
    lastText = cleaned;
    lastSentAt = now;
    pending = pending
      .then(async () => {
        await telegramApi<unknown>(state, "sendMessageDraft", telegramDraftPayload(message, draftId, cleaned));
      })
      .catch(async (error) => {
        disabled = true;
        if (warningLogged) return;
        warningLogged = true;
        const errMessage = error instanceof Error ? error.message : String(error);
        await appendEventLog(state.config, {
          level: "warn",
          source: "telegram",
          event: "draft_stream_failed",
          message: errMessage.slice(0, 200),
          details: { chat_id: message.chat.id, message_thread_id: message.message_thread_id },
        });
      });
  };

  return {
    update(text, options = {}) {
      enqueue(text, options.force === true);
    },
    onChatProgress(event) {
      switch (event.kind) {
        case "thinking":
          enqueue(l("Thinking", "考えています"));
          break;
        case "tool_running":
          enqueue(l(`Running skill: ${event.skill_id}`, `スキルを実行しています: ${event.skill_id}`), true);
          break;
        case "tool_repairing":
          enqueue(l(`Repairing and rerunning skill: ${event.skill_id}`, `スキルを修正して再実行しています: ${event.skill_id}`), true);
          break;
        case "tool_done":
          enqueue(l("Checking result", "結果を確認しています"));
          break;
        case "model_failed":
          enqueue(l("Error occurred", "エラーになりました"), true);
          break;
      }
    },
    onAiProgress(event) {
      const text = formatTelegramDraftProgress(event);
      if (text) enqueue(text, event.kind === "message");
    },
    onBuildProgress(event) {
      const text = formatTelegramDraftProgress(event);
      if (text) enqueue(text, event.kind === "message" || event.kind === "tool");
    },
    async finish() {
      await pending;
    },
  };
}

function noopTelegramDraftStreamer(): TelegramDraftStreamer {
  return {
    update() {},
    onChatProgress() {},
    onAiProgress() {},
    onBuildProgress() {},
    async finish() {},
  };
}

function createTelegramDraftId(): number {
  return Math.floor(Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1_000_000);
}

function telegramDraftIntervalMs(): number {
  const raw = Number.parseInt(process.env.AGENT_SIN_TELEGRAM_DRAFT_INTERVAL_MS || "", 10);
  if (Number.isFinite(raw) && raw >= 750) {
    return raw;
  }
  return 1500;
}

function cleanDraftText(text: string): string {
  const cleaned = stripInternalControlBlocks(text)
    .replace(/```/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/@/g, "@\u200b")
    .trim();
  if (!cleaned) return "";
  const capped = cleaned.length > DRAFT_PREVIEW_MAX ? `${cleaned.slice(0, DRAFT_PREVIEW_MAX).trimEnd()}...` : cleaned;
  return capped.slice(0, DRAFT_MESSAGE_MAX);
}

interface TypingHandle {
  stop(): void;
}

function startTypingKeepalive(
  state: TelegramBotState,
  chatId: string,
  threadId: number | undefined,
): TypingHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    if (stopped) return;
    void sendTelegramChatAction(state, chatId, threadId);
  };
  tick();
  timer = setInterval(tick, TYPING_REFRESH_MS);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

async function sendTelegramMessage(
  state: TelegramBotState,
  chatId: string,
  content: string,
  options: TelegramSendOptions = {},
): Promise<void> {
  const sanitized = stripInternalControlBlocks(content);
  if (!sanitized.trim()) {
    return;
  }
  const chunks = chunkTelegramMessage(sanitized);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const payload = telegramSendPayload(
      chatId,
      chunk,
      index === 0 ? options : { threadId: options.threadId },
    );
    try {
      await telegramApi<unknown>(state, "sendMessage", payload);
    } catch (error) {
      if (index === 0 && options.replyToMessageId) {
        try {
          await telegramApi<unknown>(
            state,
            "sendMessage",
            telegramSendPayload(chatId, chunk, { threadId: options.threadId }),
          );
          continue;
        } catch {
          // Keep the original error for logging.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin telegram: send error: ${message}`);
      await appendEventLog(state.config, {
        level: "error",
        source: "telegram",
        event: "send_error",
        message,
        details: { chat_id: chatId },
      });
      return;
    }
  }
}

async function sendTelegramChatAction(
  state: TelegramBotState,
  chatId: string,
  threadId?: number,
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      action: "typing",
    };
    if (threadId) {
      payload.message_thread_id = threadId;
    }
    await telegramApi<unknown>(state, "sendChatAction", payload);
  } catch {
    // typing indicator is a hint; ignore failures
  }
}

async function telegramApi<T>(
  state: TelegramBotState,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${state.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }
  return data.result as T;
}

async function loadTelegramOffset(filePath: string): Promise<number | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { offset?: unknown };
    if (typeof data.offset === "number" && Number.isInteger(data.offset) && data.offset >= 0) {
      return data.offset;
    }
  } catch {
    // missing or unreadable: start fresh and skip stale updates
  }
  return null;
}

async function saveTelegramOffset(state: TelegramBotState): Promise<void> {
  if (state.offset === null) return;
  try {
    await mkdir(path.dirname(state.offsetFile), { recursive: true });
    const payload = JSON.stringify(
      { offset: state.offset, saved_at: new Date().toISOString() },
      null,
      2,
    );
    await writeFile(state.offsetFile, payload, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin telegram: failed to persist offset: ${message}`);
  }
}

export async function loadTelegramHistories(filePath: string): Promise<Map<string, ChatTurn[]>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { chats?: Record<string, unknown> };
    const map = new Map<string, ChatTurn[]>();
    if (data.chats && typeof data.chats === "object") {
      for (const [chatKey, value] of Object.entries(data.chats)) {
        if (!Array.isArray(value)) continue;
        const turns: ChatTurn[] = [];
        for (const entry of value) {
          if (!entry || typeof entry !== "object") continue;
          const role = (entry as { role?: unknown }).role;
          const content = (entry as { content?: unknown }).content;
          if (
            (role === "user" || role === "assistant" || role === "tool") &&
            typeof content === "string"
          ) {
            turns.push({ role, content });
          }
        }
        if (turns.length > 0) {
          map.set(chatKey, turns.slice(-TELEGRAM_CONTEXT_HISTORY_LIMIT));
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function saveTelegramHistories(state: TelegramBotState): Promise<void> {
  try {
    await mkdir(path.dirname(state.historiesFile), { recursive: true });
    const chats: Record<string, ChatTurn[]> = {};
    for (const [chatKey, history] of state.histories) {
      if (history.length === 0) continue;
      chats[chatKey] = history;
    }
    const payload = JSON.stringify(
      { chats, saved_at: new Date().toISOString() },
      null,
      2,
    );
    await writeFile(state.historiesFile, payload, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin telegram: failed to persist histories: ${message}`);
  }
}

export async function loadTelegramIntentRuntimes(filePath: string): Promise<Map<string, IntentRuntime>> {
  return loadIntentRuntimeMap(filePath, "chats");
}

async function saveTelegramIntentRuntimes(state: TelegramBotState): Promise<void> {
  try {
    await saveIntentRuntimeMap(state.intentRuntimesFile, "chats", state.intentRuntimes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin telegram: failed to persist intent runtimes: ${message}`);
  }
}

function trimHistory(history: ChatTurn[]): void {
  if (history.length <= TELEGRAM_CONTEXT_HISTORY_LIMIT) {
    return;
  }
  history.splice(0, history.length - TELEGRAM_CONTEXT_HISTORY_LIMIT);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
