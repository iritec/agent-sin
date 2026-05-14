import WebSocket from "ws";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadConfig, loadModels, type AppConfig } from "../core/config.js";
import { appendEventLog } from "../core/logger.js";
import {
  type ChatProgressEvent,
  type ChatTurn,
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
import { isBuildCommandText, runBuildCommandText } from "../builder/build-command-router.js";
import { formatBuildProgress, progressIntervalMs } from "../builder/progress-format.js";
import {
  chunkText,
  cleanAttachmentText,
  formatAttachmentLabel,
  formatBytes,
  guessImageMimeType as guessImageMimeTypeFromName,
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
import { modelsLines, skillsLines } from "../core/info-lines.js";
import { consumeUpdateBanner, scheduleUpdateCheck } from "../core/update-notifier.js";
import { runSkill, SkillRunError } from "../core/runtime.js";
import { loadSkillMemory } from "../core/memory.js";
import {
  findSkillManifest,
  listSkillManifests,
  type DiscordSlashInvocation,
  type DiscordSlashOption,
  type SkillManifest,
} from "../core/skill-registry.js";

const GATEWAY_VERSION = 10;
const GATEWAY_URL = `wss://gateway.discord.gg/?v=${GATEWAY_VERSION}&encoding=json`;
const REST_BASE = `https://discord.com/api/v${GATEWAY_VERSION}`;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const INTENTS_BASE = INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES;
const MESSAGE_MAX = 2000;
const RECONNECT_DELAY_MS = 5000;
const TYPING_REFRESH_MS = 9000;
const DISCORD_CONTEXT_HISTORY_LIMIT = 20;
const ATTACHMENT_TEXT_MAX_BYTES = 96 * 1024;
const ATTACHMENT_TEXT_MAX_CHARS = 20_000;
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_SUMMARY_LIMIT = 8;

const STATUS_EMOJI = {
  received: "\u{1F440}",
  thinking: "\u{1F914}",
  tool: "\u{1F6E0}\u{FE0F}",
  done: "✅",
  error: "⚠\u{FE0F}",
} as const;

export type StatusKind = keyof typeof STATUS_EMOJI;

export interface DiscordUser {
  id: string;
  username: string;
  bot?: boolean;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  mentions: DiscordUser[];
  attachments?: DiscordAttachment[];
}

export interface DiscordAttachment {
  id?: string;
  filename?: string;
  title?: string;
  description?: string;
  content_type?: string;
  size?: number;
  url?: string;
  proxy_url?: string;
}

export interface MessageContext {
  isDirect: boolean;
  isMentioned: boolean;
  isAllowed: boolean;
  isListenChannel: boolean;
  isBotThread: boolean;
}

interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
  options?: DiscordInteractionOption[];
}

interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  data?: {
    id?: string;
    name?: string;
    options?: DiscordInteractionOption[];
  };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  channel_id?: string;
  guild_id?: string;
}

export function shouldRespond(ctx: MessageContext): boolean {
  if (!ctx.isAllowed) return false;
  return ctx.isDirect || ctx.isMentioned || ctx.isBotThread;
}

export function renderModeBadge(_intentRuntime: IntentRuntime): string {
  // Mode header badges have been removed in favor of in-line phrasing for
  // pending confirmations and a trailing footer for active build mode.
  return "";
}

export function withModeBadge(
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
    exitPrefix: "!",
    languageHint: [options.userText ?? "", ...lines],
  });
  if (!footer) return lines;
  return [...lines, "", footer];
}

interface BotState {
  config: AppConfig;
  token: string;
  allowedUserIds: Set<string>;
  listenChannelIds: Set<string>;
  botThreadIds: Set<string>;
  threadsFile: string;
  lastSeenFile: string;
  lastSeenIds: Map<string, string>;
  dmChannelIds: Set<string>;
  processedMessageIds: Set<string>;
  catchUpDone: boolean;
  intents: number;
  botUserId: string | null;
  histories: Map<string, ChatTurn[]>;
  historiesLoaded: Set<string>;
  intentRuntimes: Map<string, IntentRuntime>;
  intentRuntimesFile: string;
  ws: WebSocket | null;
  seq: number | null;
  sessionId: string | null;
  heartbeatTimer: NodeJS.Timeout | null;
  heartbeatAcked: boolean;
  reconnect: boolean;
}

const PROCESSED_MESSAGE_LIMIT = 500;
const CATCHUP_MAX_PER_CHANNEL = 50;
const CATCHUP_MAX_AGE_MS = 5 * 60 * 1000;
const DISCORD_EPOCH = 1420070400000n;

export async function runDiscordBot(config: AppConfig): Promise<number> {
  const token = (process.env.AGENT_SIN_DISCORD_BOT_TOKEN || "").trim();
  if (!token) {
    console.error(
      "AGENT_SIN_DISCORD_BOT_TOKEN is not set. Add it to ~/.agent-sin/.env or export it.",
    );
    return 1;
  }
  const allowedRaw = process.env.AGENT_SIN_DISCORD_ALLOWED_USER_IDS || "";
  const allowedUserIds = parseSnowflakeList(allowedRaw);
  if (allowedUserIds.size === 0) {
    console.error(
      "AGENT_SIN_DISCORD_ALLOWED_USER_IDS is empty. Set it to your Discord user ID(s) (comma separated) so the bot only replies to you.",
    );
    return 1;
  }

  const listenChannelIds = parseSnowflakeList(process.env.AGENT_SIN_DISCORD_LISTEN_CHANNEL_IDS || "");
  const threadsFile = path.join(config.workspace, "discord", "bot-threads.json");
  const botThreadIds = await loadBotThreadIds(threadsFile);
  const lastSeenFile = path.join(config.workspace, "discord", "last-seen.json");
  const { lastSeenIds, dmChannelIds } = await loadLastSeen(lastSeenFile);
  const intentRuntimesFile = path.join(config.workspace, "discord", "intent-runtimes.json");
  const persistedIntentRuntimes = await loadIntentRuntimes(intentRuntimesFile);
  // Reading thread replies that don't @mention the bot requires the privileged Message Content intent.
  const intents =
    listenChannelIds.size > 0 || botThreadIds.size > 0 ? INTENTS_BASE | INTENT_MESSAGE_CONTENT : INTENTS_BASE;

  const state: BotState = {
    config,
    token,
    allowedUserIds,
    listenChannelIds,
    botThreadIds,
    threadsFile,
    lastSeenFile,
    lastSeenIds,
    dmChannelIds,
    processedMessageIds: new Set(),
    catchUpDone: false,
    intents,
    botUserId: null,
    histories: new Map(),
    historiesLoaded: new Set(),
    intentRuntimes: persistedIntentRuntimes,
    intentRuntimesFile,
    ws: null,
    seq: null,
    sessionId: null,
    heartbeatTimer: null,
    heartbeatAcked: true,
    reconnect: true,
  };

  const shutdown = () => {
    state.reconnect = false;
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    state.ws?.close(1000, "shutdown");
    console.log("agent-sin discord: shutting down");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  scheduleUpdateCheck(config.workspace);

  await appendEventLog(config, {
    level: "info",
    source: "discord",
    event: "bot_starting",
    details: {
      allowed_user_count: allowedUserIds.size,
      listen_channel_count: listenChannelIds.size,
      bot_thread_count: botThreadIds.size,
      message_content_intent: (intents & INTENT_MESSAGE_CONTENT) !== 0,
    },
  });
  console.log(
    `agent-sin discord: starting (allowed users: ${allowedUserIds.size}, listen channels: ${listenChannelIds.size}, known threads: ${botThreadIds.size}${
      (intents & INTENT_MESSAGE_CONTENT) !== 0 ? ", privileged Message Content intent required" : ""
    })`,
  );

  while (state.reconnect) {
    try {
      await connectAndRun(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin discord: gateway error: ${message}`);
      await appendEventLog(config, {
        level: "error",
        source: "discord",
        event: "gateway_error",
        message,
      });
    }
    if (state.reconnect) {
      console.log(`agent-sin discord: reconnecting in ${Math.round(RECONNECT_DELAY_MS / 1000)}s…`);
      await sleep(RECONNECT_DELAY_MS);
    }
  }
  await appendEventLog(config, { level: "info", source: "discord", event: "bot_stopped" });
  return 0;
}

export function parseSnowflakeList(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const trimmed = part.trim();
    if (trimmed && /^\d+$/.test(trimmed)) {
      ids.add(trimmed);
    }
  }
  return ids;
}

/** @deprecated use parseSnowflakeList */
export const parseAllowedUserIds = parseSnowflakeList;

export function classifyMessage(
  message: DiscordMessage,
  botUserId: string | null,
  allowedUserIds: Set<string>,
  listenChannelIds: Set<string> = new Set(),
  botThreadIds: Set<string> = new Set(),
): MessageContext {
  const isDirect = !message.guild_id;
  const isMentioned = botUserId
    ? Array.isArray(message.mentions) && message.mentions.some((user) => user.id === botUserId)
    : false;
  const isAllowed = allowedUserIds.has(message.author.id);
  const isListenChannel = listenChannelIds.has(message.channel_id);
  const isBotThread = botThreadIds.has(message.channel_id);
  return { isDirect, isMentioned, isAllowed, isListenChannel, isBotThread };
}

export function stripBotMention(content: string, botUserId: string): string {
  if (!botUserId) {
    return content.trim();
  }
  const pattern = new RegExp(`<@!?${botUserId}>`, "g");
  return content.replace(pattern, "").trim();
}

const BADGE_PREFIX_PATTERN = /^(💬|🔧|✏️|✏)/u;
const BUILD_FOOTER_FIRST_LINE =
  /^(?:(?:✏️|✏|🔧)\s*現在ビルドモードです|（(?:現在：「[^」]*」の)?ビルドモード(?:です。抜けるには|を抜けるには).+?と返事してください）)\s*$/u;

export function stripBadgePrefix(content: string): string {
  if (!content) return "";
  let lines = content.split("\n");
  if (lines.length > 0 && BADGE_PREFIX_PATTERN.test(lines[0].trim())) {
    // Skip legacy header badge + optional meta lines until the "----" separator (or up to 4 lines).
    let i = 1;
    for (; i < Math.min(lines.length, 5); i += 1) {
      if (lines[i].trim() === "----") {
        i += 1;
        break;
      }
    }
    lines = lines.slice(i);
  }
  // Strip trailing build-mode footer (icon + 現在ビルドモードです + 戻り方案内).
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (BUILD_FOOTER_FIRST_LINE.test(lines[j].trim())) {
      // Drop blank separators above the footer too.
      let cut = j;
      while (cut > 0 && lines[cut - 1].trim() === "") cut -= 1;
      lines = lines.slice(0, cut);
      break;
    }
  }
  return lines.join("\n").trim();
}

export function buildChatHistoryFromMessages(
  messages: DiscordMessage[],
  botUserId: string | null,
  allowedUserIds: Set<string>,
): ChatTurn[] {
  const history: ChatTurn[] = [];
  for (const message of messages) {
    if (message.author?.bot) {
      if (!message.content || !message.content.trim()) continue;
      if (!botUserId || message.author.id !== botUserId) continue;
      const stripped = stripBadgePrefix(message.content).trim();
      if (stripped) history.push({ role: "assistant", content: stripped });
      continue;
    }
    if (allowedUserIds.size > 0 && !allowedUserIds.has(message.author.id)) continue;
    const cleaned = formatDiscordUserMessageForHistory(message, botUserId);
    if (cleaned) history.push({ role: "user", content: cleaned });
  }
  return history;
}

export function formatDiscordUserMessageForHistory(
  message: DiscordMessage,
  botUserId: string | null,
): string {
  const text = botUserId ? stripBotMention(message.content || "", botUserId) : (message.content || "").trim();
  const attachments = formatDiscordAttachmentSummary(message.attachments);
  return [text, attachments].filter(Boolean).join("\n\n").trim();
}

export function formatDiscordAttachmentSummary(attachments: DiscordAttachment[] | undefined): string {
  const normalized = normalizeDiscordAttachments(attachments);
  if (normalized.length === 0) {
    return "";
  }
  const shown = normalized.slice(0, ATTACHMENT_SUMMARY_LIMIT);
  const lines = [l("[Discord attachments]", "[Discord添付]")];
  shown.forEach((attachment, index) => {
    lines.push(`${index + 1}. ${formatDiscordAttachmentLabel(attachment)}`);
    const url = attachment.url || attachment.proxy_url;
    if (url) {
      lines.push(`   URL: ${url}`);
    }
    if (attachment.description) {
      lines.push(l(`   Description: ${cleanAttachmentText(attachment.description, 500)}`, `   説明: ${cleanAttachmentText(attachment.description, 500)}`));
    }
  });
  if (normalized.length > shown.length) {
    lines.push(l(`...and ${normalized.length - shown.length} more`, `...他 ${normalized.length - shown.length} 件`));
  }
  return lines.join("\n");
}

async function formatDiscordUserMessageForChat(
  state: BotState,
  message: DiscordMessage,
  botUserId: string | null,
): Promise<{ text: string; images: AiImagePart[] }> {
  const text = botUserId ? stripBotMention(message.content || "", botUserId) : (message.content || "").trim();
  const attachments = await formatDiscordAttachmentDetails(state, message.attachments);
  return {
    text: [text, attachments.text].filter(Boolean).join("\n\n").trim(),
    images: attachments.images,
  };
}

async function formatDiscordAttachmentDetails(
  state: BotState,
  attachments: DiscordAttachment[] | undefined,
): Promise<{ text: string; images: AiImagePart[] }> {
  const normalized = normalizeDiscordAttachments(attachments);
  if (normalized.length === 0) {
    return { text: "", images: [] };
  }
  const shown = normalized.slice(0, ATTACHMENT_SUMMARY_LIMIT);
  const lines = [l("[Discord attachments]", "[Discord添付]")];
  const images: AiImagePart[] = [];
  for (let index = 0; index < shown.length; index += 1) {
    const attachment = shown[index];
    lines.push(`${index + 1}. ${formatDiscordAttachmentLabel(attachment)}`);
    const url = attachment.url || attachment.proxy_url;
    if (url) {
      lines.push(`   URL: ${url}`);
    }
    if (attachment.description) {
      lines.push(l(`   Description: ${cleanAttachmentText(attachment.description, 500)}`, `   説明: ${cleanAttachmentText(attachment.description, 500)}`));
    }
    if (isImageAttachment(attachment)) {
      const image = await readDiscordAttachmentImage(state, attachment);
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
      const content = await readDiscordAttachmentText(state, attachment);
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

async function readDiscordAttachmentText(
  state: BotState,
  attachment: DiscordAttachment,
): Promise<{ kind: "text"; text: string } | { kind: "skipped"; reason?: string }> {
  if (!isTextLikeAttachment(attachment)) {
    return { kind: "skipped", reason: l("This file type is not auto-extracted.", "この形式は本文を自動抽出していません。") };
  }
  const url = attachment.url || attachment.proxy_url;
  if (!url) {
    return { kind: "skipped", reason: l("No URL, so text could not be fetched.", "URL がないため本文を取得できません。") };
  }
  if (typeof attachment.size === "number" && attachment.size > ATTACHMENT_TEXT_MAX_BYTES) {
    return {
      kind: "skipped",
      reason: l(`Text attachment is too large and was skipped (${formatBytes(attachment.size)}).`, `テキスト添付が大きすぎるため読み取りを省略しました（${formatBytes(attachment.size)}）。`),
    };
  }
  try {
    const response = await fetch(url, { headers: { authorization: `Bot ${state.token}` } });
    if (!response.ok) {
      return { kind: "skipped", reason: l(`Text fetch failed (HTTP ${response.status}).`, `本文取得に失敗しました（HTTP ${response.status}）。`) };
    }
    const length = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(length) && length > ATTACHMENT_TEXT_MAX_BYTES) {
      return {
        kind: "skipped",
        reason: l(`Text attachment is too large and was skipped (${formatBytes(length)}).`, `テキスト添付が大きすぎるため読み取りを省略しました（${formatBytes(length)}）。`),
      };
    }
    const contentType = response.headers.get("content-type") || attachment.content_type;
    if (!isTextLikeAttachment({ ...attachment, content_type: contentType })) {
      return { kind: "skipped", reason: l("This file type is not auto-extracted.", "この形式は本文を自動抽出していません。") };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > ATTACHMENT_TEXT_MAX_BYTES) {
      return {
        kind: "skipped",
        reason: l(`Text attachment is too large and was skipped (${formatBytes(buffer.length)}).`, `テキスト添付が大きすぎるため読み取りを省略しました（${formatBytes(buffer.length)}）。`),
      };
    }
    const text = cleanAttachmentText(buffer.toString("utf8"), ATTACHMENT_TEXT_MAX_CHARS);
    if (!text) {
      return { kind: "skipped", reason: l("The text body was empty.", "本文が空でした。") };
    }
    return { kind: "text", text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "discord",
      event: "attachment_read_failed",
      message: message.slice(0, 200),
      details: {
        filename: attachment.filename || attachment.title,
        content_type: attachment.content_type,
      },
    });
    return { kind: "skipped", reason: l("An error occurred while fetching text.", "本文取得でエラーになりました。") };
  }
}

async function readDiscordAttachmentImage(
  state: BotState,
  attachment: DiscordAttachment,
): Promise<
  | { kind: "image"; part: AiImagePart; savedPath?: string }
  | { kind: "skipped"; reason?: string }
> {
  const url = attachment.url || attachment.proxy_url;
  if (!url) {
    return { kind: "skipped", reason: l("No URL, so the image could not be fetched.", "URL がないため画像を取得できません。") };
  }
  if (typeof attachment.size === "number" && attachment.size > ATTACHMENT_IMAGE_MAX_BYTES) {
    return {
      kind: "skipped",
      reason: l(`Image is too large and was skipped (${formatBytes(attachment.size)}).`, `画像が大きすぎるため添付を省略しました（${formatBytes(attachment.size)}）。`),
    };
  }
  try {
    const response = await fetch(url, { headers: { authorization: `Bot ${state.token}` } });
    if (!response.ok) {
      return { kind: "skipped", reason: l(`Image fetch failed (HTTP ${response.status}).`, `画像取得に失敗しました（HTTP ${response.status}）。`) };
    }
    const length = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(length) && length > ATTACHMENT_IMAGE_MAX_BYTES) {
      return {
        kind: "skipped",
        reason: l(`Image is too large and was skipped (${formatBytes(length)}).`, `画像が大きすぎるため添付を省略しました（${formatBytes(length)}）。`),
      };
    }
    const contentType = response.headers.get("content-type") || attachment.content_type || guessImageMimeType(attachment);
    if (!contentType.toLowerCase().startsWith("image/")) {
      return { kind: "skipped", reason: l("Could not read it as an image.", "画像形式として取得できませんでした。") };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > ATTACHMENT_IMAGE_MAX_BYTES) {
      return {
        kind: "skipped",
        reason: l(`Image is too large and was skipped (${formatBytes(buffer.length)}).`, `画像が大きすぎるため添付を省略しました（${formatBytes(buffer.length)}）。`),
      };
    }
    const mimeType = contentType.split(";")[0].trim() || "image/png";
    const savedPath = await persistDiscordAttachmentBuffer(state, attachment, buffer, mimeType);
    return {
      kind: "image",
      part: {
        type: "image",
        image_url: `data:${mimeType};base64,${buffer.toString("base64")}`,
        mime_type: mimeType,
        filename: attachment.filename || attachment.title,
      },
      savedPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "discord",
      event: "attachment_image_read_failed",
      message: message.slice(0, 200),
      details: {
        filename: attachment.filename || attachment.title,
        content_type: attachment.content_type,
      },
    });
    return { kind: "skipped", reason: l("An error occurred while fetching the image.", "画像取得でエラーになりました。") };
  }
}

async function persistDiscordAttachmentBuffer(
  state: BotState,
  attachment: DiscordAttachment,
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
    const ext = pickAttachmentExtension(attachment.filename || attachment.title, mimeType);
    const random = Math.random().toString(36).slice(2, 8);
    const filename = `${yyyy}${MM}${dd}-${HH}${mm}${ss}-${random}${ext}`;
    const fullPath = path.join(dir, filename);
    await writeFile(fullPath, buffer);
    return fullPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "discord",
      event: "attachment_persist_failed",
      message: message.slice(0, 200),
      details: {
        filename: attachment.filename || attachment.title,
        content_type: attachment.content_type,
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

function normalizeDiscordAttachments(attachments: DiscordAttachment[] | undefined): DiscordAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((attachment) => attachment && typeof attachment === "object");
}

function firstAttachmentName(attachments: DiscordAttachment[] | undefined): string {
  const attachment = normalizeDiscordAttachments(attachments)[0];
  return attachment ? attachment.filename || attachment.title || l("attachment", "添付ファイル") : "";
}

function formatDiscordAttachmentLabel(attachment: DiscordAttachment): string {
  return formatAttachmentLabel({
    name: attachment.filename || attachment.title,
    fallback: l("attachment", "添付ファイル"),
    contentType: attachment.content_type,
    size: attachment.size,
  });
}

function isTextLikeAttachment(attachment: DiscordAttachment): boolean {
  return isTextLikeFile(attachment.content_type, attachment.filename || attachment.title);
}

function isImageAttachment(attachment: DiscordAttachment): boolean {
  return isImageLikeFile(attachment.content_type, attachment.filename || attachment.title);
}

function guessImageMimeType(attachment: DiscordAttachment): string {
  return guessImageMimeTypeFromName(attachment.filename || attachment.title);
}

export function shouldResetDiscordHistory(ctx: MessageContext): boolean {
  return ctx.isMentioned && !ctx.isDirect && !ctx.isBotThread;
}

export function chunkMessage(text: string, max: number = MESSAGE_MAX): string[] {
  return chunkText(text, max);
}

function connectAndRun(state: BotState): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(GATEWAY_URL);
    state.ws = ws;
    state.heartbeatAcked = true;

    ws.on("open", () => {
      console.log("agent-sin discord: gateway open");
    });

    ws.on("message", (data) => {
      let payload: GatewayPayload;
      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        payload = JSON.parse(text) as GatewayPayload;
      } catch {
        console.error("agent-sin discord: invalid JSON from gateway");
        return;
      }
      handleGatewayPayload(state, payload).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`agent-sin discord: handler error: ${message}`);
      });
    });

    ws.on("close", (code, reason) => {
      if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
      }
      const reasonStr = reason ? reason.toString() : "";
      console.log(`agent-sin discord: gateway closed (code ${code}${reasonStr ? `, ${reasonStr}` : ""})`);
      void appendEventLog(state.config, {
        level: code === 1000 ? "info" : "warn",
        source: "discord",
        event: "gateway_closed",
        message: reasonStr || undefined,
        details: { code, will_reconnect: state.reconnect },
      }).catch(() => {});
      if (code === 4014) {
        console.error(
          "agent-sin discord: disallowed intent. The bot needs the privileged 'Message Content' intent to read replies inside threads (and listen channels) without an @mention. Enable it in the Discord developer portal under Bot → Privileged Gateway Intents.",
        );
      }
      if (code === 4004 || code === 4014 || code === 4013 || code === 4011 || code === 4012) {
        // Authentication / disallowed intent / sharding errors are fatal for our use case.
        state.reconnect = false;
      }
      resolve();
    });

    ws.on("error", (error) => {
      console.error(`agent-sin discord: socket error: ${error.message}`);
      void appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "gateway_socket_error",
        message: error.message,
      }).catch(() => {});
    });
  });
}

interface GatewayPayload {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}

async function handleGatewayPayload(state: BotState, payload: GatewayPayload): Promise<void> {
  if (typeof payload.s === "number") {
    state.seq = payload.s;
  }
  switch (payload.op) {
    case 10: // Hello
      handleHello(state, payload.d?.heartbeat_interval ?? 41250);
      sendIdentify(state);
      break;
    case 11: // Heartbeat ACK
      state.heartbeatAcked = true;
      break;
    case 1: // Server requested heartbeat
      sendHeartbeat(state);
      break;
    case 7: // Reconnect
      state.ws?.close(4000, "reconnect requested");
      break;
    case 9: // Invalid Session
      setTimeout(() => sendIdentify(state), 5000);
      break;
    case 0: // Dispatch
      if (payload.t === "READY") {
        state.botUserId = payload.d?.user?.id ?? null;
        state.sessionId = payload.d?.session_id ?? null;
        const username = payload.d?.user?.username || "?";
        console.log(`agent-sin discord: ready as ${username} (${state.botUserId})`);
        await appendEventLog(state.config, {
          level: "info",
          source: "discord",
          event: "ready",
          details: { bot_user_id: state.botUserId },
        });
        if (!state.catchUpDone) {
          state.catchUpDone = true;
          catchUpMissedMessages(state).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`agent-sin discord: catch-up failed: ${message}`);
          });
        }
        void registerSlashCommands(state);
      } else if (payload.t === "MESSAGE_CREATE") {
        await handleMessage(state, payload.d as DiscordMessage);
      } else if (payload.t === "INTERACTION_CREATE") {
        await handleInteraction(state, payload.d as DiscordInteraction);
      }
      break;
    default:
      // ignore other ops
      break;
  }
}

function handleHello(state: BotState, intervalMs: number): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
  }
  // Initial jitter per Discord docs.
  setTimeout(() => sendHeartbeat(state), Math.random() * intervalMs);
  state.heartbeatTimer = setInterval(() => {
    if (!state.heartbeatAcked) {
      void appendEventLog(state.config, {
        level: "warn",
        source: "discord",
        event: "heartbeat_missed",
        details: { interval_ms: intervalMs },
      }).catch(() => {});
      state.ws?.close(4000, "missed heartbeat ack");
      return;
    }
    sendHeartbeat(state);
  }, intervalMs);
  if (typeof state.heartbeatTimer.unref === "function") {
    state.heartbeatTimer.unref();
  }
}

function sendHeartbeat(state: BotState): void {
  state.heartbeatAcked = false;
  state.ws?.send(JSON.stringify({ op: 1, d: state.seq }));
}

function sendIdentify(state: BotState): void {
  const identify = {
    op: 2,
    d: {
      token: state.token,
      intents: state.intents,
      properties: {
        os: process.platform,
        browser: "agent-sin",
        device: "agent-sin",
      },
    },
  };
  state.ws?.send(JSON.stringify(identify));
}

async function handleMessage(state: BotState, message: DiscordMessage): Promise<void> {
  if (!message || !message.author || message.author.bot) {
    return;
  }
  if (message.id) {
    if (state.processedMessageIds.has(message.id)) {
      return;
    }
    state.processedMessageIds.add(message.id);
    if (state.processedMessageIds.size > PROCESSED_MESSAGE_LIMIT) {
      const first = state.processedMessageIds.values().next().value as string | undefined;
      if (first) state.processedMessageIds.delete(first);
    }
  }
  const ctx = classifyMessage(
    message,
    state.botUserId,
    state.allowedUserIds,
    state.listenChannelIds,
    state.botThreadIds,
  );
  rememberLastSeen(state, message, ctx).catch((error) => {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: failed to persist last-seen: ${errMessage}`);
  });
  if (!shouldRespond(ctx)) {
    if ((ctx.isDirect || ctx.isMentioned || ctx.isBotThread) && !ctx.isAllowed) {
      await appendEventLog(state.config, {
        level: "warn",
        source: "discord",
        event: "blocked_user",
        details: { user_id: message.author.id, channel_id: message.channel_id },
      });
    } else if (ctx.isListenChannel || ctx.isBotThread || ctx.isDirect) {
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "message_ignored",
        message: (message.content || "").slice(0, 120),
        details: {
          channel_id: message.channel_id,
          guild_id: message.guild_id,
          author_id: message.author.id,
          message_id: message.id,
          is_direct: ctx.isDirect,
          is_mentioned: ctx.isMentioned,
          is_allowed: ctx.isAllowed,
          is_listen_channel: ctx.isListenChannel,
          is_bot_thread: ctx.isBotThread,
          mention_count: Array.isArray(message.mentions) ? message.mentions.length : 0,
          mention_user_ids: Array.isArray(message.mentions)
            ? message.mentions.map((user) => user.id).slice(0, 5)
            : [],
          bot_user_id: state.botUserId,
        },
      });
    }
    return;
  }

  const cleanText = state.botUserId
    ? stripBotMention(message.content || "", state.botUserId)
    : (message.content || "").trim();

  if (cleanText === "!help") {
    await sendChannelMessage(state, message.channel_id, helpText());
    return;
  }
  if (cleanText === "!reset") {
    state.histories.delete(message.channel_id);
    state.historiesLoaded.delete(message.channel_id);
    await sendChannelMessage(state, message.channel_id, l("Chat history reset.", "会話履歴をリセットしました。"));
    return;
  }
  if (cleanText === "/skills" || cleanText === "/skills --all") {
    const lines = await skillsLines(state.config);
    await sendChannelMessage(state, message.channel_id, lines.join("\n"));
    return;
  }
  if (cleanText === "/models") {
    const lines = await modelsLines(state.config);
    await sendChannelMessage(state, message.channel_id, lines.join("\n"));
    return;
  }
  if (await tryRunTodoSlashCommand(state, message, cleanText)) {
    return;
  }
  if (await tryRunModelSlashCommand(state, message, cleanText)) {
    return;
  }
  const progressCommand = handleProgressCommand(state, message.channel_id, cleanText);
  if (progressCommand) {
    await sendChannelMessage(state, message.channel_id, progressCommand.join("\n"));
    return;
  }
  const userMessage = await formatDiscordUserMessageForChat(state, message, state.botUserId);
  const userText = userMessage.text;
  if (!userText) {
    await sendChannelMessage(
      state,
      message.channel_id,
      l("Please enter a message. Use `!help` for usage.", "メッセージを入力してください。`!help` で使い方を表示します。"),
    );
    return;
  }

  // Reactions go on the user's original message regardless of where we reply.
  const status = createStatusReactor(state, message.channel_id, message.id);
  await status.set("received");

  // If this is a mention in a "listen" parent channel, spin up a fresh thread
  // and run the conversation inside it. Subsequent replies in that thread no
  // longer require @mentioning the bot.
  let replyChannelId = message.channel_id;
  const shouldSpawnThread = !ctx.isDirect && !ctx.isBotThread && ctx.isMentioned && ctx.isListenChannel;
  if (shouldSpawnThread) {
    const threadName = makeThreadName(cleanText || firstAttachmentName(message.attachments));
    const thread = await createThreadFromMessage(state, message.channel_id, message.id, threadName);
    if (thread) {
      replyChannelId = thread.id;
      state.botThreadIds.add(thread.id);
      await saveBotThreadIds(state);
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "thread_created",
        details: { thread_id: thread.id, parent_channel_id: message.channel_id, name: threadName },
      });
    }
    // If thread creation failed, fall back to replying in the parent channel.
  }

  // Fresh @mention outside a bot thread = new conversation. Inside a bot
  // thread, even explicit @mentions should keep the thread context.
  const treatAsNewConversation = shouldResetDiscordHistory(ctx);

  let history: ChatTurn[];

  if (treatAsNewConversation) {
    // Explicit fresh @mention starts clean so a new request does not inherit a
    // previous build mode by accident.
    history = [];
    state.histories.set(replyChannelId, history);
    state.historiesLoaded.add(replyChannelId);
    if (state.intentRuntimes.delete(replyChannelId)) {
      void saveIntentRuntimes(state);
    }
  } else {
    // Pull the latest Discord thread/channel contents on every turn. This keeps
    // AI context aligned with the actual thread even after restarts, missed
    // gateway events, or user-side @mentions inside the thread.
    const refreshed = await refreshDiscordHistoryBeforeCurrentMessage(state, replyChannelId, message.id);
    if (!refreshed.ok) {
      await status.set("error");
      await sendChannelMessage(
        state,
        replyChannelId,
        l("I could not reload the Discord thread history, so I stopped this reply. Wait a moment and send it again.", "Discord スレッドの履歴を読み直せなかったため、応答を止めました。少し待ってからもう一度送ってください。"),
      );
      return;
    }
    history = refreshed.history;
  }

  let intentRuntime = state.intentRuntimes.get(replyChannelId);
  if (!intentRuntime) {
    intentRuntime = createIntentRuntime(true);
    state.intentRuntimes.set(replyChannelId, intentRuntime);
  }

  await refreshStateConfig(state);

  await withLocale(inferLocaleFromText(userText), async () => {
    const typing = startTypingKeepalive(state, replyChannelId);
    const prevMode = intentRuntime.mode;
    try {
      const lines = await routeDiscordMessage(
        state,
        userText,
        history,
        intentRuntime,
        status,
        replyChannelId,
        userMessage.images,
      );
      typing.stop();
      void saveIntentRuntimes(state);
      const isBuildEntry = prevMode !== "build" && intentRuntime.mode === "build";
      const decorated = withModeBadge(intentRuntime, lines, { userText, isBuildEntry });
      scheduleUpdateCheck(state.config.workspace);
      const banner = await consumeUpdateBanner(state.config.workspace);
      const finalLines = banner ? [banner, "", ...decorated] : decorated;
      const reply = finalLines.filter((line) => line !== undefined && line !== null).join("\n").trim();
      if (reply) {
        await sendChannelMessage(state, replyChannelId, reply);
      } else {
        await sendChannelMessage(state, replyChannelId, l("(no response)", "（応答なし）"));
      }
    } catch (error) {
      typing.stop();
      await status.set("error");
      const errMessage = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin discord: routeDiscordMessage failed: ${errMessage}`);
      await sendChannelMessage(state, replyChannelId, l(`Error: ${errMessage}`, `エラー: ${errMessage}`));
    }
  });
}

async function refreshStateConfig(state: BotState): Promise<void> {
  try {
    state.config = await loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(state.config, {
      level: "warn",
      source: "discord",
      event: "config_refresh_failed",
      message,
    });
  }
}

async function refreshDiscordHistoryBeforeCurrentMessage(
  state: BotState,
  channelId: string,
  beforeMessageId: string,
): Promise<{ ok: true; history: ChatTurn[] } | { ok: false; error: string }> {
  try {
    const past = await fetchChannelHistoryBefore(
      state,
      channelId,
      beforeMessageId,
      DISCORD_CONTEXT_HISTORY_LIMIT,
    );
    const history = buildChatHistoryFromMessages(past, state.botUserId, state.allowedUserIds);
    state.histories.set(channelId, history);
    state.historiesLoaded.add(channelId);
    return { ok: true, history };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: history refresh failed: ${message}`);
    await appendEventLog(state.config, {
      level: "error",
      source: "discord",
      event: "history_refresh_failed",
      message,
      details: { channel_id: channelId, before_message_id: beforeMessageId },
    });
    return { ok: false, error: message };
  }
}

async function routeDiscordMessage(
  state: BotState,
  text: string,
  history: ChatTurn[],
  intentRuntime: IntentRuntime,
  status: StatusReactor,
  replyChannelId: string,
  images: AiImagePart[] = [],
): Promise<string[]> {
  let modelFailed = false;
  const lines = await routeConversationMessage({
    config: state.config,
    text,
    history,
    intentRuntime,
    eventSource: "discord",
    images,
    isBuildCommand: (value) => isBuildCommandText(value, ["!"]),
    runBuildCommand: (value, hooks) => runBuildCommand(state.config, value, hooks),
    createBuildProgress: () => createDiscordBuildProgressReporter(state, replyChannelId, status),
    onBuildStart: () => status.set("tool"),
    onBuildDone: () => status.set("done"),
    onChatProgress: (event) => {
      void onChatProgressForReactions(event, status);
      if (event.kind === "model_failed") {
        modelFailed = true;
      }
    },
  });
  await status.set(modelFailed ? "error" : "done");
  return lines;
}

async function onChatProgressForReactions(
  event: ChatProgressEvent,
  status: StatusReactor,
): Promise<void> {
  switch (event.kind) {
    case "thinking":
      await status.set("thinking");
      break;
    case "tool_running":
    case "tool_repairing":
      await status.set("tool");
      break;
    case "tool_done":
      // Return to thinking so the next iteration's update is visible if it changes again.
      await status.set("thinking");
      break;
    case "model_failed":
      await status.set("error");
      break;
  }
}

function createDiscordBuildProgressReporter(
  state: BotState,
  channelId: string,
  status: StatusReactor,
): BuildProgressReporter {
  const minIntervalMs = discordProgressIntervalMs();
  let lastSentAt = 0;
  let lastText = "";
  let sent = 0;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (text: string, kind: StatusKind): void => {
    pending = pending
      .then(async () => {
        await status.set(kind);
        await sendChannelMessage(state, channelId, text);
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await appendEventLog(state.config, {
          level: "warn",
          source: "discord",
          event: "build_progress_failed",
          message: message.slice(0, 200),
          details: { channel_id: channelId },
        });
      });
  };

  return {
    onProgress(event: AiProgressEvent): void {
      void status.set(statusKindForBuildProgress(event));
      const text = formatDiscordBuildProgress(event, {
        detail: isDiscordProgressDetailEnabled(state, channelId),
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
      enqueue(text, statusKindForBuildProgress(event));
    },
    async flush(): Promise<void> {
      await pending;
    },
  };
}

function isDiscordProgressDetailEnabled(state: BotState, channelId: string): boolean {
  if (process.env.AGENT_SIN_DISCORD_PROGRESS_DETAIL === "1") {
    return true;
  }
  return state.intentRuntimes.get(channelId)?.progress_detail === true;
}

function discordProgressIntervalMs(): number {
  return progressIntervalMs("AGENT_SIN_DISCORD_PROGRESS_INTERVAL_MS");
}

export function formatDiscordBuildProgress(
  event: AiProgressEvent,
  options: { detail?: boolean } = {},
): string | null {
  return formatBuildProgress(event, options);
}

function statusKindForBuildProgress(event: AiProgressEvent): StatusKind {
  return event.kind === "tool" || event.kind === "stderr" ? "tool" : "thinking";
}

interface StatusReactor {
  set(kind: StatusKind): Promise<void>;
}

function createStatusReactor(state: BotState, channelId: string, messageId: string): StatusReactor {
  let current: StatusKind | null = null;
  let pending: Promise<void> = Promise.resolve();
  return {
    set(kind: StatusKind): Promise<void> {
      // Serialize reaction updates so a fast burst of progress events doesn't race.
      pending = pending.then(async () => {
        if (current === kind) return;
        const prev = current;
        current = kind;
        const nextEmoji = STATUS_EMOJI[kind];
        try {
          await addReaction(state, channelId, messageId, nextEmoji);
        } catch {
          // network blip — keep going
        }
        if (prev) {
          const prevEmoji = STATUS_EMOJI[prev];
          if (prevEmoji !== nextEmoji) {
            try {
              await removeOwnReaction(state, channelId, messageId, prevEmoji);
            } catch {
              // ignore
            }
          }
        }
      });
      return pending;
    },
  };
}

async function addReaction(state: BotState, channelId: string, messageId: string, emoji: string): Promise<void> {
  const url = `${REST_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bot ${state.token}` },
  });
  if (!response.ok && response.status !== 204) {
    const detail = await response.text().catch(() => "");
    if (response.status !== 403 && response.status !== 404) {
      console.error(`agent-sin discord: addReaction failed: HTTP ${response.status} ${detail.slice(0, 120)}`);
    }
  }
}

async function removeOwnReaction(state: BotState, channelId: string, messageId: string, emoji: string): Promise<void> {
  const url = `${REST_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
  await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bot ${state.token}` },
  });
}

interface TypingHandle {
  stop(): void;
}

function startTypingKeepalive(state: BotState, channelId: string): TypingHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    if (stopped) return;
    void sendTypingIndicator(state, channelId);
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

async function runBuildCommand(
  config: AppConfig,
  text: string,
  hooks: { onProgress?: AiProgressHandler } = {},
): Promise<string[]> {
  return runBuildCommandText(config, text, { displayPrefix: "!", onProgress: hooks.onProgress });
}

export type TodoSlashParse =
  | { kind: "help"; lines: string[] }
  | { kind: "error"; lines: string[] }
  | { kind: "run"; skillId: "todo-add" | "todo-list" | "todo-done" | "todo-delete"; args: Record<string, unknown> };

export function parseTodoSlashCommand(text: string): TodoSlashParse | null {
  const trimmed = (text || "").trim();
  if (trimmed !== "/todo" && !/^\/todo\s/.test(trimmed)) {
    return null;
  }
  const rest = trimmed === "/todo" ? "" : trimmed.replace(/^\/todo\s+/, "").trim();
  if (!rest || rest === "help" || rest === "--help" || rest === "-h") {
    return { kind: "help", lines: todoSlashHelpLines() };
  }
  const firstSpace = rest.search(/\s/);
  const sub = (firstSpace >= 0 ? rest.slice(0, firstSpace) : rest).toLowerCase();
  const remainder = firstSpace >= 0 ? rest.slice(firstSpace + 1).trim() : "";

  if (sub === "add") {
    if (!remainder) {
      return {
        kind: "error",
        lines: [
          l(
            "Usage: /todo add <text> [--due 2026-05-17T18:00:00+09:00]",
            "使い方: /todo add <本文> [--due 2026-05-17T18:00:00+09:00]",
          ),
        ],
      };
    }
    const { text: body, due } = extractTodoDueFlag(remainder);
    if (!body) {
      return {
        kind: "error",
        lines: [l("ToDo text is required.", "ToDoの本文を指定してください。")],
      };
    }
    const args: Record<string, unknown> = { text: body };
    if (due) args.due = due;
    return { kind: "run", skillId: "todo-add", args };
  }

  if (sub === "list") {
    const filterRaw = (remainder.split(/\s+/)[0] || "open").toLowerCase();
    const allowed = new Set(["open", "done", "all"]);
    if (!allowed.has(filterRaw)) {
      return {
        kind: "error",
        lines: [
          l(
            `Unknown filter: ${filterRaw}. Use open / done / all.`,
            `未対応のフィルタです: ${filterRaw}。open / done / all のいずれかにしてください。`,
          ),
        ],
      };
    }
    return { kind: "run", skillId: "todo-list", args: { status: filterRaw } };
  }

  if (sub === "done") {
    const id = (remainder.split(/\s+/)[0] || "").trim();
    if (!id) {
      return { kind: "error", lines: [l("Usage: /todo done <id>", "使い方: /todo done <id>")] };
    }
    return { kind: "run", skillId: "todo-done", args: { id } };
  }

  if (sub === "delete" || sub === "remove" || sub === "del") {
    const id = (remainder.split(/\s+/)[0] || "").trim();
    if (!id) {
      return { kind: "error", lines: [l("Usage: /todo delete <id>", "使い方: /todo delete <id>")] };
    }
    return { kind: "run", skillId: "todo-delete", args: { id } };
  }

  return {
    kind: "error",
    lines: [
      l(`Unknown subcommand: ${sub}.`, `未対応のサブコマンドです: ${sub}。`),
      ...todoSlashHelpLines(),
    ],
  };
}

function extractTodoDueFlag(rest: string): { text: string; due?: string } {
  const match = rest.match(/(^|\s)--due\s+(\S+)(?=\s|$)/);
  if (!match) return { text: rest.trim() };
  const start = match.index ?? 0;
  const before = rest.slice(0, start);
  const after = rest.slice(start + match[0].length);
  const text = [before, after].map((segment) => segment.trim()).filter(Boolean).join(" ").trim();
  return { text, due: match[2] };
}

function todoSlashHelpLines(): string[] {
  return lLines(
    [
      "Quick ToDo commands:",
      "/todo add <text> [--due 2026-05-17T18:00:00+09:00] — add a ToDo",
      "/todo list [open|done|all] — list ToDos (default: open)",
      "/todo done <id> — mark a ToDo as done",
      "/todo delete <id> — delete a ToDo",
    ],
    [
      "ToDoのショートカット:",
      "/todo add <本文> [--due 2026-05-17T18:00:00+09:00] — ToDoを追加",
      "/todo list [open|done|all] — ToDoを一覧表示（既定: open）",
      "/todo done <id> — ToDoを完了にする",
      "/todo delete <id> — ToDoを削除",
    ],
  );
}

async function tryRunTodoSlashCommand(
  state: BotState,
  message: DiscordMessage,
  cleanText: string,
): Promise<boolean> {
  const parsed = await withLocale(inferLocaleFromText(cleanText), () =>
    Promise.resolve(parseTodoSlashCommand(cleanText)),
  );
  if (!parsed) return false;

  await withLocale(inferLocaleFromText(cleanText), async () => {
    const status = createStatusReactor(state, message.channel_id, message.id);
    await status.set("received");

    if (parsed.kind === "help") {
      await status.set("done");
      await sendChannelMessage(state, message.channel_id, parsed.lines.join("\n"));
      return;
    }
    if (parsed.kind === "error") {
      await status.set("error");
      await sendChannelMessage(state, message.channel_id, parsed.lines.join("\n"));
      return;
    }

    await status.set("tool");
    try {
      const response = await runSkill(state.config, parsed.skillId, parsed.args);
      const display =
        response.result.summary ||
        response.result.title ||
        l("(no response)", "（応答なし）");
      await status.set(response.result.status === "ok" ? "done" : "error");
      await sendChannelMessage(state, message.channel_id, display);
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "todo_slash_ran",
        message: response.result.title || undefined,
        details: {
          skill_id: parsed.skillId,
          status: response.result.status,
          channel_id: message.channel_id,
        },
      });
    } catch (error) {
      await status.set("error");
      const detail =
        error instanceof SkillRunError
          ? error.originalMessage
          : error instanceof Error
            ? error.message
            : String(error);
      await sendChannelMessage(
        state,
        message.channel_id,
        l(`Error: ${detail}`, `エラー: ${detail}`),
      );
      await appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "todo_slash_failed",
        message: detail.slice(0, 200),
        details: { skill_id: parsed.skillId, channel_id: message.channel_id },
      });
    }
  });

  return true;
}

export type ModelSlashParse =
  | { kind: "help"; lines: string[] }
  | { kind: "list" }
  | { kind: "set"; id: string };

export function parseModelSlashCommand(text: string): ModelSlashParse | null {
  const trimmed = (text || "").trim();
  if (trimmed !== "/model" && !/^\/model\s/.test(trimmed)) {
    return null;
  }
  const rest = trimmed === "/model" ? "" : trimmed.replace(/^\/model\s+/, "").trim();
  if (!rest) return { kind: "list" };
  if (rest === "help" || rest === "--help" || rest === "-h") {
    return { kind: "help", lines: modelSlashHelpLines() };
  }
  const id = rest.split(/\s+/)[0]?.trim() || "";
  if (!id) return { kind: "list" };
  return { kind: "set", id };
}

function modelSlashHelpLines(): string[] {
  return lLines(
    [
      "Chat model commands:",
      "/model — show current chat model and candidates",
      "/model <id> — switch the chat model to <id>",
    ],
    [
      "チャットモデルのショートカット:",
      "/model — 現在のチャットモデルと候補を表示",
      "/model <id> — チャットモデルを <id> に切り替え",
    ],
  );
}

type ModelListEntry = {
  id?: string;
  type?: string;
  provider?: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
  roles?: string[];
};

function modelEntrySummary(entry: ModelListEntry): string {
  const parts: string[] = [];
  parts.push(entry.provider || entry.type || "-");
  if (entry.model) parts.push(String(entry.model));
  if (entry.effort) parts.push(`effort=${entry.effort}`);
  if (entry.enabled === false) parts.push(l("disabled", "無効"));
  return parts.join(" ");
}

function formatChatModelView(data: unknown): string {
  const obj = (data as Record<string, unknown>) || {};
  const roles = (obj.roles as Record<string, unknown> | undefined) || {};
  const chatId = typeof roles.chat === "string" ? roles.chat : "";
  const rawEntries = Array.isArray(obj.models) ? (obj.models as ModelListEntry[]) : [];
  const current = rawEntries.find((m) => m.id === chatId);
  const others = rawEntries.filter((m) => m.id !== chatId);

  const lines: string[] = [];
  if (current) {
    lines.push(l(`chat: ${current.id} (${modelEntrySummary(current)})`, `chat: ${current.id}（${modelEntrySummary(current)}）`));
  } else {
    lines.push(`chat: ${chatId || "-"}`);
  }
  if (others.length === 0) {
    lines.push(l("No other models registered.", "他に登録されたモデルはありません。"));
  } else {
    const ids = others.map((m) => m.id).filter(Boolean).join(", ");
    lines.push(l(`Candidates: ${ids}`, `候補: ${ids}`));
  }
  return lines.join("\n");
}

async function tryRunModelSlashCommand(
  state: BotState,
  message: DiscordMessage,
  cleanText: string,
): Promise<boolean> {
  const parsed = await withLocale(inferLocaleFromText(cleanText), () =>
    Promise.resolve(parseModelSlashCommand(cleanText)),
  );
  if (!parsed) return false;

  await withLocale(inferLocaleFromText(cleanText), async () => {
    const status = createStatusReactor(state, message.channel_id, message.id);
    await status.set("received");

    if (parsed.kind === "help") {
      await status.set("done");
      await sendChannelMessage(state, message.channel_id, parsed.lines.join("\n"));
      return;
    }

    const skillId: "model-list" | "model-set" = parsed.kind === "list" ? "model-list" : "model-set";
    const args: Record<string, unknown> = parsed.kind === "list" ? {} : { role: "chat", id: parsed.id };

    await status.set("tool");
    try {
      const response = await runSkill(state.config, skillId, args);
      let display: string;
      if (parsed.kind === "list" && response.result.status === "ok") {
        display = formatChatModelView(response.result.data);
      } else {
        display =
          response.result.summary ||
          response.result.title ||
          l("(no response)", "（応答なし）");
      }
      await status.set(response.result.status === "ok" ? "done" : "error");
      await sendChannelMessage(state, message.channel_id, display);
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "model_slash_ran",
        message: response.result.title || undefined,
        details: {
          skill_id: skillId,
          status: response.result.status,
          channel_id: message.channel_id,
        },
      });
    } catch (error) {
      await status.set("error");
      const detail =
        error instanceof SkillRunError
          ? error.originalMessage
          : error instanceof Error
            ? error.message
            : String(error);
      await sendChannelMessage(
        state,
        message.channel_id,
        l(`Error: ${detail}`, `エラー: ${detail}`),
      );
      await appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "model_slash_failed",
        message: detail.slice(0, 200),
        details: { skill_id: skillId, channel_id: message.channel_id },
      });
    }
  });

  return true;
}

const TODO_SLASH_COMMAND_DEFINITION = {
  name: "todo",
  description: "ToDo shortcut commands",
  description_localizations: { ja: "ToDoのショートカット" },
  type: 1,
  dm_permission: true,
  options: [
    {
      type: 1,
      name: "add",
      description: "Add a ToDo",
      description_localizations: { ja: "ToDoを追加" },
      options: [
        {
          type: 3,
          name: "text",
          description: "ToDo text",
          description_localizations: { ja: "ToDoの本文" },
          required: true,
        },
        {
          type: 3,
          name: "due",
          description: "Optional ISO8601 date-time, e.g. 2026-05-17T18:00:00+09:00",
          description_localizations: { ja: "ISO8601の期限（任意、例 2026-05-17T18:00:00+09:00）" },
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "list",
      description: "List ToDos",
      description_localizations: { ja: "ToDoを一覧表示" },
      options: [
        {
          type: 3,
          name: "filter",
          description: "Which ToDos to show",
          description_localizations: { ja: "表示する範囲" },
          required: false,
          choices: [
            { name: "open", value: "open" },
            { name: "done", value: "done" },
            { name: "all", value: "all" },
          ],
        },
      ],
    },
    {
      type: 1,
      name: "done",
      description: "Mark a ToDo as done",
      description_localizations: { ja: "ToDoを完了にする" },
      options: [
        {
          type: 3,
          name: "id",
          description: "Pick a ToDo",
          description_localizations: { ja: "ToDoを選択" },
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      type: 1,
      name: "delete",
      description: "Delete a ToDo",
      description_localizations: { ja: "ToDoを削除する" },
      options: [
        {
          type: 3,
          name: "id",
          description: "Pick a ToDo",
          description_localizations: { ja: "ToDoを選択" },
          required: true,
          autocomplete: true,
        },
      ],
    },
  ],
} as const;

const MODEL_SLASH_COMMAND_DEFINITION = {
  name: "model",
  description: "Show or switch the chat model",
  description_localizations: { ja: "チャットモデルの表示・切り替え" },
  type: 1,
  dm_permission: true,
  options: [
    {
      type: 3,
      name: "id",
      description: "Model ID to switch to (omit to list)",
      description_localizations: { ja: "切り替え先のモデルID（省略で一覧表示）" },
      required: false,
      autocomplete: true,
    },
  ],
} as const;

const BUILTIN_SLASH_COMMAND_DEFINITIONS: ReadonlyArray<{ name: string } & Record<string, unknown>> = [
  TODO_SLASH_COMMAND_DEFINITION,
  MODEL_SLASH_COMMAND_DEFINITION,
];

const DISCORD_SLASH_OPTION_TYPE_CODE: Record<DiscordSlashOption["type"], number> = {
  string: 3,
  integer: 4,
  boolean: 5,
  number: 10,
};

export function manifestToSlashDefinition(
  manifest: SkillManifest,
): ({ name: string } & Record<string, unknown>) | null {
  const slash = manifest.invocation?.discord_slash;
  if (!slash) return null;
  const description =
    (slash.description && slash.description.trim()) ||
    (manifest.description && manifest.description.trim()) ||
    manifest.name ||
    manifest.id;
  const definition: Record<string, unknown> = {
    name: manifest.id,
    description: description.slice(0, 100),
    type: 1,
    dm_permission: true,
  };
  if (slash.description_ja) {
    definition.description_localizations = { ja: slash.description_ja.slice(0, 100) };
  }
  if (slash.options && slash.options.length > 0) {
    definition.options = slash.options.map((option) => {
      const optDef: Record<string, unknown> = {
        type: DISCORD_SLASH_OPTION_TYPE_CODE[option.type],
        name: option.name,
        description: ((option.description && option.description.trim()) || option.name).slice(0, 100),
        required: option.required === true,
      };
      if (option.description_ja) {
        optDef.description_localizations = { ja: option.description_ja.slice(0, 100) };
      }
      if (option.choices && option.choices.length > 0) {
        optDef.choices = option.choices.map((choice) => ({
          name: choice.name,
          value: choice.value,
        }));
      }
      return optDef;
    });
  }
  return definition as { name: string } & Record<string, unknown>;
}

export async function composeSlashCommandDefinitions(
  config: AppConfig,
): Promise<ReadonlyArray<{ name: string } & Record<string, unknown>>> {
  const builtin = BUILTIN_SLASH_COMMAND_DEFINITIONS;
  const builtinNames = new Set(builtin.map((d) => d.name));
  let skillManifests: SkillManifest[] = [];
  try {
    skillManifests = await listSkillManifests(config.skills_dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: listSkillManifests failed: ${message}`);
    return builtin;
  }
  const fromSkills: Array<{ name: string } & Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const manifest of skillManifests) {
    if (manifest.enabled === false) continue;
    if (!manifest.invocation?.discord_slash) continue;
    if (builtinNames.has(manifest.id)) {
      console.warn(
        `agent-sin discord: skill "${manifest.id}" collides with a builtin slash command — ignoring discord_slash`,
      );
      continue;
    }
    if (seen.has(manifest.id)) continue;
    const definition = manifestToSlashDefinition(manifest);
    if (definition) {
      fromSkills.push(definition);
      seen.add(manifest.id);
    }
  }
  return [...builtin, ...fromSkills];
}

const BUILTIN_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SLASH_COMMAND_DEFINITIONS.map((d) => d.name),
);

async function registerSlashCommands(state: BotState): Promise<void> {
  if (!state.botUserId) return;
  const url = `${REST_BASE}/applications/${state.botUserId}/commands`;
  const definitions = await composeSlashCommandDefinitions(state.config);
  for (const definition of definitions) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bot ${state.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(definition),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(
          `agent-sin discord: register /${definition.name} failed: HTTP ${response.status} ${detail.slice(0, 300)}`,
        );
        await appendEventLog(state.config, {
          level: "warn",
          source: "discord",
          event: "slash_register_failed",
          message: `HTTP ${response.status}: ${detail.slice(0, 200)}`,
          details: { command: definition.name },
        });
        continue;
      }
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "slash_registered",
        details: { command: definition.name },
      });
      console.log(`agent-sin discord: /${definition.name} slash command registered (global)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin discord: register /${definition.name} error: ${message}`);
      await appendEventLog(state.config, {
        level: "warn",
        source: "discord",
        event: "slash_register_error",
        message,
        details: { command: definition.name },
      });
    }
  }
}

async function handleInteraction(state: BotState, interaction: DiscordInteraction): Promise<void> {
  if (!interaction) return;
  const name = interaction.data?.name;
  if (name === "todo") {
    if (interaction.type === 4) {
      await handleTodoAutocomplete(state, interaction);
      return;
    }
    if (interaction.type === 2) {
      await handleTodoInteraction(state, interaction);
    }
    return;
  }
  if (name === "model") {
    if (interaction.type === 4) {
      await handleModelAutocomplete(state, interaction);
      return;
    }
    if (interaction.type === 2) {
      await handleModelInteraction(state, interaction);
    }
    return;
  }
  if (!name || BUILTIN_SLASH_COMMAND_NAMES.has(name)) return;
  if (interaction.type !== 2) return;
  try {
    await findSkillManifest(state.config.skills_dir, name);
  } catch {
    await respondInteraction(state, interaction, {
      content: l(`Unknown command: /${name}`, `未対応のコマンドです: /${name}`),
      ephemeral: true,
    });
    return;
  }
  await handleSkillSlashInteraction(state, interaction, name);
}

async function handleSkillSlashInteraction(
  state: BotState,
  interaction: DiscordInteraction,
  skillId: string,
): Promise<void> {
  const userId = await ensureInteractionUserAllowed(state, interaction, skillId);
  if (!userId) return;

  const args: Record<string, unknown> = {};
  const localeParts: string[] = [];
  for (const opt of interaction.data?.options || []) {
    if (opt.value !== undefined) {
      args[opt.name] = opt.value;
      if (typeof opt.value === "string") localeParts.push(opt.value);
    }
  }

  await withLocale(inferLocaleFromText(localeParts.join(" ")), async () => {
    const ack = await deferInteraction(state, interaction);
    if (!ack) return;

    try {
      const response = await runSkill(state.config, skillId, args);
      const display =
        response.result.summary ||
        response.result.title ||
        l("(no response)", "（応答なし）");
      await editInteractionOriginal(state, interaction, display);
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "skill_slash_ran",
        message: response.result.title || undefined,
        details: {
          skill_id: skillId,
          status: response.result.status,
          kind: "interaction",
        },
      });
    } catch (error) {
      const detail =
        error instanceof SkillRunError
          ? error.originalMessage
          : error instanceof Error
            ? error.message
            : String(error);
      await editInteractionOriginal(
        state,
        interaction,
        l(`Error: ${detail}`, `エラー: ${detail}`),
      );
      await appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "skill_slash_failed",
        message: detail.slice(0, 200),
        details: { skill_id: skillId, kind: "interaction" },
      });
    }
  });
}

async function ensureInteractionUserAllowed(
  state: BotState,
  interaction: DiscordInteraction,
  commandName: string,
): Promise<string | null> {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (!userId || !state.allowedUserIds.has(userId)) {
    await appendEventLog(state.config, {
      level: "warn",
      source: "discord",
      event: "interaction_blocked_user",
      details: { user_id: userId || null, command: commandName },
    });
    await respondInteraction(state, interaction, {
      content: l(
        "You are not allowed to use this command.",
        "このコマンドを使う権限がありません。",
      ),
      ephemeral: true,
    });
    return null;
  }
  return userId;
}

async function handleTodoInteraction(state: BotState, interaction: DiscordInteraction): Promise<void> {
  const userId = await ensureInteractionUserAllowed(state, interaction, "todo");
  if (!userId) return;

  const sub = interaction.data?.options?.[0];
  const subName = sub?.name || "";
  const optMap = new Map<string, unknown>();
  for (const opt of sub?.options || []) {
    optMap.set(opt.name, opt.value);
  }

  await withLocale(inferLocaleFromText(extractInteractionLocaleHint(sub)), async () => {
    let skillId: "todo-add" | "todo-list" | "todo-done" | "todo-delete";
    let args: Record<string, unknown>;

    if (subName === "add") {
      const text = String(optMap.get("text") || "").trim();
      if (!text) {
        await respondInteraction(state, interaction, {
          content: l("ToDo text is required.", "ToDoの本文を指定してください。"),
          ephemeral: true,
        });
        return;
      }
      skillId = "todo-add";
      args = { text };
      const due = optMap.get("due");
      if (due) args.due = String(due);
    } else if (subName === "list") {
      skillId = "todo-list";
      args = { status: String(optMap.get("filter") || "open") };
    } else if (subName === "done" || subName === "delete") {
      const id = String(optMap.get("id") || "").trim();
      if (!id) {
        await respondInteraction(state, interaction, {
          content: l("ToDo ID is required.", "ToDoのIDを指定してください。"),
          ephemeral: true,
        });
        return;
      }
      skillId = subName === "done" ? "todo-done" : "todo-delete";
      args = { id };
    } else {
      await respondInteraction(state, interaction, {
        content: l(
          `Unknown subcommand: ${subName || "(none)"}.`,
          `未対応のサブコマンドです: ${subName || "(なし)"}。`,
        ),
        ephemeral: true,
      });
      return;
    }

    const ack = await deferInteraction(state, interaction);
    if (!ack) return;

    try {
      const response = await runSkill(state.config, skillId, args);
      const display =
        response.result.summary ||
        response.result.title ||
        l("(no response)", "（応答なし）");
      await editInteractionOriginal(state, interaction, display);
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "todo_slash_ran",
        message: response.result.title || undefined,
        details: {
          skill_id: skillId,
          status: response.result.status,
          kind: "interaction",
        },
      });
    } catch (error) {
      const detail =
        error instanceof SkillRunError
          ? error.originalMessage
          : error instanceof Error
            ? error.message
            : String(error);
      await editInteractionOriginal(
        state,
        interaction,
        l(`Error: ${detail}`, `エラー: ${detail}`),
      );
      await appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "todo_slash_failed",
        message: detail.slice(0, 200),
        details: { skill_id: skillId, kind: "interaction" },
      });
    }
  });
}

async function handleModelInteraction(state: BotState, interaction: DiscordInteraction): Promise<void> {
  const userId = await ensureInteractionUserAllowed(state, interaction, "model");
  if (!userId) return;

  const optMap = new Map<string, unknown>();
  for (const opt of interaction.data?.options || []) {
    optMap.set(opt.name, opt.value);
  }
  const id = String(optMap.get("id") || "").trim();
  const localeHint = id || "";

  await withLocale(inferLocaleFromText(localeHint), async () => {
    const skillId: "model-list" | "model-set" = id ? "model-set" : "model-list";
    const args: Record<string, unknown> = id ? { role: "chat", id } : {};

    const ack = await deferInteraction(state, interaction);
    if (!ack) return;

    try {
      const response = await runSkill(state.config, skillId, args);
      let display: string;
      if (!id && response.result.status === "ok") {
        display = formatChatModelView(response.result.data);
      } else {
        display =
          response.result.summary ||
          response.result.title ||
          l("(no response)", "（応答なし）");
      }
      await editInteractionOriginal(state, interaction, display);
      await appendEventLog(state.config, {
        level: "info",
        source: "discord",
        event: "model_slash_ran",
        message: response.result.title || undefined,
        details: {
          skill_id: skillId,
          status: response.result.status,
          kind: "interaction",
        },
      });
    } catch (error) {
      const detail =
        error instanceof SkillRunError
          ? error.originalMessage
          : error instanceof Error
            ? error.message
            : String(error);
      await editInteractionOriginal(
        state,
        interaction,
        l(`Error: ${detail}`, `エラー: ${detail}`),
      );
      await appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "model_slash_failed",
        message: detail.slice(0, 200),
        details: { skill_id: skillId, kind: "interaction" },
      });
    }
  });
}

async function handleModelAutocomplete(
  state: BotState,
  interaction: DiscordInteraction,
): Promise<void> {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (!userId || !state.allowedUserIds.has(userId)) {
    await respondAutocomplete(state, interaction, []);
    return;
  }

  let focusedValue = "";
  for (const opt of interaction.data?.options || []) {
    if (opt.focused) {
      focusedValue = typeof opt.value === "string" ? opt.value : "";
      break;
    }
  }

  let entries: Array<[string, { provider?: string; model?: string; effort?: string; type?: string; enabled?: boolean }]> = [];
  let chatId = "";
  try {
    const models = await loadModels(state.config.workspace);
    chatId = state.config.chat_model_id || "";
    entries = Object.entries(models.models);
  } catch {
    await respondAutocomplete(state, interaction, []);
    return;
  }

  const query = focusedValue.trim().toLowerCase();
  const filtered = query
    ? entries.filter(([id, entry]) => {
        const haystack = [
          id,
          entry.provider || "",
          entry.model || "",
          entry.type || "",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : entries;

  filtered.sort(([aId], [bId]) => {
    if (aId === chatId && bId !== chatId) return -1;
    if (bId === chatId && aId !== chatId) return 1;
    return aId.localeCompare(bId);
  });

  const choices = filtered.slice(0, 25).map(([id, entry]) => {
    const provider = entry.provider || entry.type || "-";
    const modelName = entry.model || "";
    const effort = entry.effort ? ` effort=${entry.effort}` : "";
    const current = id === chatId ? " ← chat" : "";
    const detail = [provider, modelName].filter(Boolean).join(" ");
    const label = `${id} (${detail}${effort})${current}`;
    return {
      name: label.length > 100 ? label.slice(0, 97) + "…" : label,
      value: id,
    };
  });

  await respondAutocomplete(state, interaction, choices);
}

function extractInteractionLocaleHint(option: DiscordInteractionOption | undefined): string {
  if (!option) return "";
  const parts: string[] = [];
  for (const child of option.options || []) {
    if (typeof child.value === "string") parts.push(child.value);
  }
  return parts.join(" ");
}

interface StoredTodoItem {
  id?: string;
  text?: string;
  status?: string;
  due?: string;
  created_at?: string;
  completed_at?: string;
}

async function loadTodoItems(state: BotState): Promise<StoredTodoItem[]> {
  try {
    const manifest = await findSkillManifest(state.config.skills_dir, "todo-list");
    const memory = await loadSkillMemory(state.config, manifest);
    const items = (memory as Record<string, unknown>).items;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is StoredTodoItem => item !== null && typeof item === "object");
  } catch {
    return [];
  }
}

async function handleTodoAutocomplete(
  state: BotState,
  interaction: DiscordInteraction,
): Promise<void> {
  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (!userId || !state.allowedUserIds.has(userId)) {
    await respondAutocomplete(state, interaction, []);
    return;
  }

  const sub = interaction.data?.options?.[0];
  const subName = sub?.name || "";
  if (subName !== "done" && subName !== "delete") {
    await respondAutocomplete(state, interaction, []);
    return;
  }

  let focusedValue = "";
  for (const opt of sub?.options || []) {
    if (opt.focused) {
      focusedValue = typeof opt.value === "string" ? opt.value : "";
      break;
    }
  }

  const items = await loadTodoItems(state);
  let candidates = subName === "done"
    ? items.filter((item) => item.status === "open")
    : items.slice();

  candidates.sort((a, b) => {
    const aOpen = a.status === "open" ? 0 : 1;
    const bOpen = b.status === "open" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const aTime = a.completed_at || a.created_at || "";
    const bTime = b.completed_at || b.created_at || "";
    return bTime.localeCompare(aTime);
  });

  const query = focusedValue.trim().toLowerCase();
  if (query) {
    candidates = candidates.filter((item) => {
      const id = (item.id || "").toLowerCase();
      const text = (item.text || "").toLowerCase();
      return id.includes(query) || text.includes(query);
    });
  }

  const choices = candidates.slice(0, 25).map((item) => {
    const mark = item.status === "done" ? "✔" : "・";
    const text = (item.text || "").trim() || (item.id || "");
    const idTag = item.id ? ` [${item.id}]` : "";
    const label = `${mark} ${text}${idTag}`;
    return {
      name: label.length > 100 ? label.slice(0, 97) + "…" : label,
      value: item.id || "",
    };
  }).filter((choice) => choice.value);

  await respondAutocomplete(state, interaction, choices);
}

async function respondAutocomplete(
  state: BotState,
  interaction: DiscordInteraction,
  choices: Array<{ name: string; value: string }>,
): Promise<void> {
  const url = `${REST_BASE}/interactions/${interaction.id}/${interaction.token}/callback`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: 8, data: { choices } }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `agent-sin discord: autocomplete respond failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: autocomplete respond error: ${message}`);
  }
}

async function respondInteraction(
  state: BotState,
  interaction: DiscordInteraction,
  options: { content: string; ephemeral?: boolean },
): Promise<void> {
  const url = `${REST_BASE}/interactions/${interaction.id}/${interaction.token}/callback`;
  const body: Record<string, unknown> = {
    type: 4,
    data: {
      content: options.content.slice(0, MESSAGE_MAX),
      ...(options.ephemeral ? { flags: 64 } : {}),
    },
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `agent-sin discord: interaction respond failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: interaction respond error: ${message}`);
  }
}

async function deferInteraction(state: BotState, interaction: DiscordInteraction): Promise<boolean> {
  const url = `${REST_BASE}/interactions/${interaction.id}/${interaction.token}/callback`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: 5 }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `agent-sin discord: interaction defer failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: interaction defer error: ${message}`);
    return false;
  }
}

async function editInteractionOriginal(
  state: BotState,
  interaction: DiscordInteraction,
  content: string,
): Promise<void> {
  const chunks = chunkMessage(content);
  const first = chunks[0] || l("(no response)", "（応答なし）");
  const editUrl = `${REST_BASE}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const response = await fetch(editUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: first }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `agent-sin discord: interaction edit failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: interaction edit error: ${message}`);
  }
  if (chunks.length <= 1) return;

  const followupUrl = `${REST_BASE}/webhooks/${interaction.application_id}/${interaction.token}`;
  for (let i = 1; i < chunks.length; i += 1) {
    try {
      const response = await fetch(followupUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: chunks[i] }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(
          `agent-sin discord: interaction followup failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin discord: interaction followup error: ${message}`);
    }
  }
}

function handleProgressCommand(state: BotState, channelId: string, text: string): string[] | null {
  if (text !== "!progress" && !text.startsWith("!progress ")) {
    return null;
  }
  const mode = text.trim().split(/\s+/)[1]?.toLowerCase() || "status";
  const current = state.intentRuntimes.get(channelId);
  if (["detail", "detailed", "verbose", "on"].includes(mode)) {
    const runtime = current || createIntentRuntime(true);
    runtime.progress_detail = true;
    state.intentRuntimes.set(channelId, runtime);
    void saveIntentRuntimes(state);
    return [l("Progress details are enabled for this thread. Use `!progress quiet` to switch back.", "このスレッドの進捗通知を詳細表示にしました。`!progress quiet` で戻せます。")];
  }
  if (["quiet", "summary", "off"].includes(mode)) {
    const runtime = current || createIntentRuntime(true);
    runtime.progress_detail = false;
    if (isEmptyIntentRuntime(runtime)) {
      state.intentRuntimes.delete(channelId);
    } else {
      state.intentRuntimes.set(channelId, runtime);
    }
    void saveIntentRuntimes(state);
    return [l("Progress is now quiet for this thread. Internal logs will not be sent to Discord.", "このスレッドの進捗通知を静音表示にしました。内部ログはDiscordに流しません。")];
  }
  if (mode === "status") {
    return [
      current?.progress_detail
        ? l("Progress details are enabled for this thread.", "このスレッドの進捗通知は詳細表示です。")
        : l("Progress is quiet for this thread.", "このスレッドの進捗通知は静音表示です。"),
    ];
  }
  return [l("Usage: !progress status | quiet | detail", "使い方: !progress status | quiet | detail")];
}

function helpText(): string {
  return lLines(
    [
      "Welcome to the Agent-Sin Discord bot.",
      "It responds in DMs, mentions, and bot-created threads. Registered skills are called automatically when useful.",
      "Mention the bot in configured channels to create a new thread. Mentions are not needed inside that thread.",
      "",
      "Status reactions:",
      `  ${STATUS_EMOJI.received} received  ${STATUS_EMOJI.thinking} thinking  ${STATUS_EMOJI.tool} running skill  ${STATUS_EMOJI.done} done  ${STATUS_EMOJI.error} error`,
      "",
      "Mode display:",
      "  In build/edit mode, replies start with `\u{1F527} build · <id>` / `✏\u{FE0F} edit · <id>`.",
      "  Send `!back`, `cancel`, or `stop` to leave build/edit mode.",
      "",
      "Quick commands:",
      "  /todo add <text> [--due ISO] · /todo list [open|done|all] · /todo done <id> · /todo delete <id>",
    ],
    [
      "Agent-Sin Discord bot へようこそ。",
      "DM、メンション、もしくは bot が作ったスレッドの中の発言に反応します。登録済みスキルも自動で呼び出されます。",
      "指定チャンネルで bot をメンションすると、そのメッセージから新しいスレッドを作って会話を続けます。スレッド内ではメンション不要です。",
      "",
      "状態の見方（あなたのメッセージへのリアクション）:",
      `  ${STATUS_EMOJI.received} 受信  ${STATUS_EMOJI.thinking} 思考中  ${STATUS_EMOJI.tool} スキル実行中  ${STATUS_EMOJI.done} 完了  ${STATUS_EMOJI.error} エラー`,
      "",
      "モード表示:",
      "  build / edit 中だけ、返信の先頭に `\u{1F527} build · <id>` / `✏\u{FE0F} edit · <id>` が出ます。",
      "  build / edit から抜けるときは `!back`、または「中止」「やめる」と送ってください。",
      "",
      "ショートカット:",
      "  /todo add <本文> [--due ISO] · /todo list [open|done|all] · /todo done <id> · /todo delete <id>",
    ],
  ).join("\n");
}

async function sendChannelMessage(state: BotState, channelId: string, content: string): Promise<void> {
  const chunks = chunkMessage(content);
  for (const chunk of chunks) {
    try {
      const response = await fetch(`${REST_BASE}/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bot ${state.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: chunk }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(`agent-sin discord: send failed: HTTP ${response.status}: ${detail.slice(0, 200)}`);
        await appendEventLog(state.config, {
          level: "error",
          source: "discord",
          event: "send_failed",
          message: `HTTP ${response.status}`,
          details: { channel_id: channelId },
        });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin discord: send error: ${message}`);
      await appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "send_error",
        message,
        details: { channel_id: channelId },
      });
      return;
    }
  }
}

async function sendTypingIndicator(state: BotState, channelId: string): Promise<void> {
  try {
    await fetch(`${REST_BASE}/channels/${channelId}/typing`, {
      method: "POST",
      headers: { authorization: `Bot ${state.token}` },
    });
  } catch {
    // typing indicator is a hint; ignore failures
  }
}

interface DiscordChannel {
  id: string;
  type: number;
  parent_id?: string;
  name?: string;
}

async function createThreadFromMessage(
  state: BotState,
  channelId: string,
  messageId: string,
  name: string,
): Promise<DiscordChannel | null> {
  const url = `${REST_BASE}/channels/${channelId}/messages/${messageId}/threads`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bot ${state.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, auto_archive_duration: 1440 }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `agent-sin discord: createThread failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
      );
      await appendEventLog(state.config, {
        level: "error",
        source: "discord",
        event: "thread_create_failed",
        message: `HTTP ${response.status}`,
        details: { channel_id: channelId, message_id: messageId },
      });
      return null;
    }
    const channel = (await response.json()) as DiscordChannel;
    return channel;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: createThread error: ${message}`);
    return null;
  }
}

export function makeThreadName(text: string): string {
  const condensed = (text || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!condensed) return "agent-sin chat";
  // Discord thread name limit is 100 chars; keep some headroom for trailing ellipsis.
  if (condensed.length <= 95) return condensed;
  return `${condensed.slice(0, 95).trimEnd()}…`;
}

async function loadBotThreadIds(filePath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { thread_ids?: unknown };
    if (Array.isArray(data?.thread_ids)) {
      return new Set(data.thread_ids.filter((value): value is string => typeof value === "string" && /^\d+$/.test(value)));
    }
  } catch {
    // missing or unreadable — start fresh
  }
  return new Set();
}

async function saveBotThreadIds(state: BotState): Promise<void> {
  try {
    await mkdir(path.dirname(state.threadsFile), { recursive: true });
    const payload = JSON.stringify(
      { thread_ids: [...state.botThreadIds].sort(), saved_at: new Date().toISOString() },
      null,
      2,
    );
    await writeFile(state.threadsFile, payload, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: failed to persist thread list: ${message}`);
  }
}

export async function loadIntentRuntimes(filePath: string): Promise<Map<string, IntentRuntime>> {
  return loadIntentRuntimeMap(filePath, "channels");
}

async function saveIntentRuntimes(state: BotState): Promise<void> {
  try {
    await saveIntentRuntimeMap(state.intentRuntimesFile, "channels", state.intentRuntimes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-sin discord: failed to persist intent runtimes: ${message}`);
  }
}

async function loadLastSeen(filePath: string): Promise<{
  lastSeenIds: Map<string, string>;
  dmChannelIds: Set<string>;
}> {
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as { channels?: Record<string, string>; dm_channel_ids?: string[] };
    const lastSeenIds = new Map<string, string>();
    if (data.channels && typeof data.channels === "object") {
      for (const [ch, id] of Object.entries(data.channels)) {
        if (/^\d+$/.test(ch) && typeof id === "string" && /^\d+$/.test(id)) {
          lastSeenIds.set(ch, id);
        }
      }
    }
    const dmChannelIds = new Set<string>();
    if (Array.isArray(data.dm_channel_ids)) {
      for (const value of data.dm_channel_ids) {
        if (typeof value === "string" && /^\d+$/.test(value)) {
          dmChannelIds.add(value);
        }
      }
    }
    return { lastSeenIds, dmChannelIds };
  } catch {
    return { lastSeenIds: new Map(), dmChannelIds: new Set() };
  }
}

async function saveLastSeen(state: BotState): Promise<void> {
  await mkdir(path.dirname(state.lastSeenFile), { recursive: true });
  const channels: Record<string, string> = {};
  for (const [ch, id] of state.lastSeenIds) {
    channels[ch] = id;
  }
  const payload = JSON.stringify(
    {
      channels,
      dm_channel_ids: [...state.dmChannelIds].sort(),
      saved_at: new Date().toISOString(),
    },
    null,
    2,
  );
  await writeFile(state.lastSeenFile, payload, "utf8");
}

async function rememberLastSeen(
  state: BotState,
  message: DiscordMessage,
  ctx: MessageContext,
): Promise<void> {
  if (!message.id || !message.channel_id) return;
  const tracked = ctx.isListenChannel || ctx.isBotThread || ctx.isDirect;
  if (!tracked) return;
  const previous = state.lastSeenIds.get(message.channel_id);
  if (previous && compareSnowflake(previous, message.id) >= 0) return;
  state.lastSeenIds.set(message.channel_id, message.id);
  if (ctx.isDirect) {
    state.dmChannelIds.add(message.channel_id);
  }
  await saveLastSeen(state);
}

function compareSnowflake(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : 1;
}

function snowflakeToDate(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return 0;
  }
}

async function catchUpMissedMessages(state: BotState): Promise<void> {
  const channels = new Set<string>([
    ...state.listenChannelIds,
    ...state.botThreadIds,
    ...state.dmChannelIds,
  ]);
  if (channels.size === 0) return;
  const cutoff = Date.now() - CATCHUP_MAX_AGE_MS;
  let total = 0;
  for (const channelId of channels) {
    try {
      const after = state.lastSeenIds.get(channelId);
      const isDm = state.dmChannelIds.has(channelId);
      const fetched = await fetchMessagesAfter(state, channelId, after, isDm);
      const fresh = fetched.filter((message) => {
        const ts = snowflakeToDate(message.id);
        return ts === 0 || ts >= cutoff;
      });
      if (fresh.length === 0) continue;
      total += fresh.length;
      for (const message of fresh) {
        await handleMessage(state, message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent-sin discord: catch-up channel ${channelId} failed: ${message}`);
    }
  }
  if (total > 0) {
    await appendEventLog(state.config, {
      level: "info",
      source: "discord",
      event: "catchup_replayed",
      details: { count: total, channels: channels.size },
    });
  }
}

async function fetchMessagesAfter(
  state: BotState,
  channelId: string,
  afterId: string | undefined,
  isDm: boolean,
): Promise<DiscordMessage[]> {
  const params = new URLSearchParams();
  params.set("limit", String(CATCHUP_MAX_PER_CHANNEL));
  if (afterId) {
    params.set("after", afterId);
  }
  const url = `${REST_BASE}/channels/${channelId}/messages?${params.toString()}`;
  const response = await fetch(url, {
    headers: { authorization: `Bot ${state.token}` },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      return [];
    }
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  const messages = (await response.json()) as DiscordMessage[];
  if (!Array.isArray(messages)) return [];
  // API returns newest first; replay oldest first.
  // /channels/{id}/messages does not include guild_id, so backfill it for guild
  // channels/threads so classifyMessage doesn't treat them as DMs.
  return messages
    .filter((message) => message && message.id && message.author && !message.author.bot)
    .map((message) => (isDm ? message : { ...message, guild_id: message.guild_id || "0", channel_id: channelId }))
    .sort((a, b) => compareSnowflake(a.id, b.id));
}

async function fetchChannelHistoryBefore(
  state: BotState,
  channelId: string,
  beforeId: string,
  limit: number,
): Promise<DiscordMessage[]> {
  const params = new URLSearchParams();
  params.set("limit", String(Math.max(1, Math.min(100, limit))));
  params.set("before", beforeId);
  const url = `${REST_BASE}/channels/${channelId}/messages?${params.toString()}`;
  const response = await fetch(url, {
    headers: { authorization: `Bot ${state.token}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  const messages = (await response.json()) as DiscordMessage[];
  if (!Array.isArray(messages)) return [];
  // API returns newest first → return oldest first.
  return messages
    .filter((message) => message && message.id && message.author)
    .sort((a, b) => compareSnowflake(a.id, b.id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
