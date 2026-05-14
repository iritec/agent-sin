import { spawn } from "node:child_process";
import { l } from "./i18n.js";

export type NotifyChannel = "macos" | "windows" | "discord" | "telegram" | "slack" | "mail" | "stderr";

export interface NotifyOptions {
  title: string;
  body: string;
  subtitle?: string;
  sound?: boolean;
  channel?: NotifyChannel | "auto";
  to?: string;
  discordThreadId?: string;
  telegramThreadId?: string;
}

export interface NotifyResult {
  channel: NotifyChannel;
  ok: boolean;
  detail?: string;
}

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_MESSAGE_LIMIT = 1900;
const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 3900;

export async function notify(options: NotifyOptions): Promise<NotifyResult> {
  const title = sanitize(options.title);
  const body = sanitize(options.body);
  const subtitle = options.subtitle ? sanitize(options.subtitle) : undefined;
  if (!title && !body) {
    throw new Error(l("notify: title or body is required", "notify: title または body が必要です"));
  }
  const requested = options.channel || "auto";
  const channel = requested === "auto" ? resolveAutoChannel() : requested;
  if (process.env.AGENT_SIN_NOTIFY_BACKEND === "stderr") {
    return notifyStderr(title, body, subtitle);
  }
  switch (channel) {
    case "macos":
      return notifyMacOs(title, body, subtitle, Boolean(options.sound));
    case "windows":
      return notifyWindows(title, body, subtitle);
    case "discord":
      return notifyDiscord(title, body, subtitle, options.discordThreadId);
    case "telegram":
      return notifyTelegram(title, body, subtitle, options.telegramThreadId);
    case "slack":
      return notifySlack(title, body, subtitle);
    case "mail":
      return notifyMail(title, body, subtitle, options.to);
    case "stderr":
      return notifyStderr(title, body, subtitle);
    default:
      return notifyStderr(title, body, subtitle);
  }
}

function resolveAutoChannel(): NotifyChannel {
  if (process.env.AGENT_SIN_NOTIFY_BACKEND === "stderr") {
    return "stderr";
  }
  if (process.env.AGENT_SIN_DISCORD_WEBHOOK_URL || hasDiscordBotNotifyConfig()) {
    return "discord";
  }
  if (hasTelegramNotifyConfig()) {
    return "telegram";
  }
  if (process.env.AGENT_SIN_SLACK_WEBHOOK_URL) {
    return "slack";
  }
  if (process.env.AGENT_SIN_SMTP_HOST && process.env.AGENT_SIN_MAIL_TO) {
    return "mail";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "win32") {
    return "windows";
  }
  return "stderr";
}

function sanitize(value: string): string {
  return value.replace(/\r/g, "").slice(0, 4000);
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function notifyMacOs(
  title: string,
  body: string,
  subtitle: string | undefined,
  withSound: boolean,
): Promise<NotifyResult> {
  const parts = [
    `display notification "${escapeAppleScript(body)}"`,
    `with title "${escapeAppleScript(title)}"`,
  ];
  if (subtitle) {
    parts.push(`subtitle "${escapeAppleScript(subtitle)}"`);
  }
  if (withSound) {
    parts.push('sound name "Glass"');
  }
  return runChild("osascript", ["-e", parts.join(" ")], "macos");
}

function escapePowerShell(value: string): string {
  // Single-quoted PowerShell strings: doubled single quote escapes a literal '.
  return value.replace(/'/g, "''");
}

async function notifyWindows(
  title: string,
  body: string,
  subtitle: string | undefined,
): Promise<NotifyResult> {
  const head = subtitle ? `${title} - ${subtitle}` : title;
  // Windows 10/11 toast via Windows Runtime APIs in PowerShell.
  // Falls back to stderr if PowerShell or WinRT is unavailable.
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime];",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime];",
    `$title = '${escapePowerShell(head)}';`,
    `$body = '${escapePowerShell(body)}';`,
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    "$nodes = $template.GetElementsByTagName('text');",
    "$nodes.Item(0).AppendChild($template.CreateTextNode($title)) | Out-Null;",
    "$nodes.Item(1).AppendChild($template.CreateTextNode($body)) | Out-Null;",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($template);",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Agent-Sin').Show($toast);",
  ].join(" ");
  const result = await runChild(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    "windows",
  );
  if (result.ok) return result;
  // Fallback: stderr so the message is not lost on systems without WinRT toast support.
  return notifyStderr(title, body, subtitle);
}

async function notifyDiscord(
  title: string,
  body: string,
  subtitle: string | undefined,
  threadIdOverride: string | undefined,
): Promise<NotifyResult> {
  const url = process.env.AGENT_SIN_DISCORD_WEBHOOK_URL;
  const content = formatPlainTextMessage(title, body, subtitle);
  const chunks = splitMessage(content, DISCORD_MESSAGE_LIMIT);
  const rawThreadId = discordNotifyThreadId(threadIdOverride);
  const threadId = normalizeDiscordSnowflake(rawThreadId);
  if (rawThreadId && !threadId) {
    return { channel: "discord", ok: false, detail: `invalid Discord thread id: ${rawThreadId}` };
  }
  if (url) {
    const webhookUrl = discordWebhookUrl(url, threadId);
    return postDiscordChunks(chunks, (chunk) => postWebhook(webhookUrl, { content: chunk }, "discord"));
  }

  const token = process.env.AGENT_SIN_DISCORD_BOT_TOKEN;
  const targetId = threadId || discordNotifyChannelId();
  if (token && targetId) {
    return postDiscordChunks(chunks, (chunk) => postDiscordBotMessage(token, targetId, chunk));
  }

  return {
    channel: "discord",
    ok: false,
    detail: "Discord notification config is not set",
  };
}

async function notifySlack(
  title: string,
  body: string,
  subtitle: string | undefined,
): Promise<NotifyResult> {
  const url = process.env.AGENT_SIN_SLACK_WEBHOOK_URL;
  if (!url) {
    return { channel: "slack", ok: false, detail: "AGENT_SIN_SLACK_WEBHOOK_URL is not set" };
  }
  const text = formatPlainTextMessage(title, body, subtitle);
  return postWebhook(url, { text }, "slack");
}

async function notifyTelegram(
  title: string,
  body: string,
  subtitle: string | undefined,
  threadIdOverride: string | undefined,
): Promise<NotifyResult> {
  const token = process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN;
  const chatId = telegramNotifyChatId();
  if (!token) {
    return { channel: "telegram", ok: false, detail: "AGENT_SIN_TELEGRAM_BOT_TOKEN is not set" };
  }
  if (!chatId) {
    return { channel: "telegram", ok: false, detail: "Telegram chat id is not set" };
  }
  const rawThreadId = telegramNotifyThreadId(threadIdOverride);
  const threadId = normalizeTelegramInteger(rawThreadId);
  if (rawThreadId && !threadId) {
    return { channel: "telegram", ok: false, detail: `invalid Telegram thread id: ${rawThreadId}` };
  }
  const content = formatPlainTextMessage(title, body, subtitle);
  const chunks = splitMessage(content, TELEGRAM_MESSAGE_LIMIT);
  return postTelegramChunks(chunks, (chunk) => postTelegramBotMessage(token, chatId, chunk, threadId));
}


async function notifyMail(
  title: string,
  body: string,
  subtitle: string | undefined,
  toOverride: string | undefined,
): Promise<NotifyResult> {
  const host = process.env.AGENT_SIN_SMTP_HOST;
  const portRaw = process.env.AGENT_SIN_SMTP_PORT || "587";
  const user = process.env.AGENT_SIN_SMTP_USER;
  const pass = process.env.AGENT_SIN_SMTP_PASS;
  const from = process.env.AGENT_SIN_MAIL_FROM || user;
  const to = toOverride || process.env.AGENT_SIN_MAIL_TO;
  const secure = (process.env.AGENT_SIN_SMTP_SECURE || "").toLowerCase() === "true";
  if (!host) {
    return { channel: "mail", ok: false, detail: "AGENT_SIN_SMTP_HOST is not set" };
  }
  if (!from) {
    return { channel: "mail", ok: false, detail: "AGENT_SIN_MAIL_FROM (or AGENT_SIN_SMTP_USER) is not set" };
  }
  if (!to) {
    return { channel: "mail", ok: false, detail: "mail recipient is not set (--to or AGENT_SIN_MAIL_TO)" };
  }
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return { channel: "mail", ok: false, detail: `invalid AGENT_SIN_SMTP_PORT: ${portRaw}` };
  }
  let createTransport: typeof import("nodemailer").createTransport;
  try {
    ({ createTransport } = await import("nodemailer"));
  } catch (error) {
    return {
      channel: "mail",
      ok: false,
      detail: `nodemailer not available: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const transporter = createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });
  const subject = subtitle ? `${title} - ${subtitle}` : title;
  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text: body,
    });
    return { channel: "mail", ok: true, detail: info.messageId };
  } catch (error) {
    return {
      channel: "mail",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function notifyStderr(
  title: string,
  body: string,
  subtitle: string | undefined,
): NotifyResult {
  const head = subtitle ? `${title} - ${subtitle}` : title;
  process.stderr.write(`[notify] ${head}: ${body}\n`);
  return { channel: "stderr", ok: true };
}

function formatPlainTextMessage(title: string, body: string, subtitle: string | undefined): string {
  const head = subtitle ? `*${title}* — ${subtitle}` : `*${title}*`;
  return body ? `${head}\n${body}` : head;
}

function hasDiscordBotNotifyConfig(): boolean {
  return Boolean(process.env.AGENT_SIN_DISCORD_BOT_TOKEN && (discordNotifyThreadId() || discordNotifyChannelId()));
}

function hasTelegramNotifyConfig(): boolean {
  return Boolean(process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN && telegramNotifyChatId());
}

function discordNotifyChannelId(): string {
  return (
    firstListValue(process.env.AGENT_SIN_DISCORD_NOTIFY_CHANNEL_ID) ||
    firstListValue(process.env.AGENT_SIN_DISCORD_CHANNEL_ID) ||
    firstListValue(process.env.AGENT_SIN_DISCORD_LISTEN_CHANNEL_IDS)
  );
}

function discordNotifyThreadId(override?: string): string {
  return (
    firstListValue(override) ||
    firstListValue(process.env.AGENT_SIN_DISCORD_NOTIFY_THREAD_ID) ||
    firstListValue(process.env.AGENT_SIN_DISCORD_THREAD_ID)
  );
}

function telegramNotifyChatId(): string {
  return (
    firstListValue(process.env.AGENT_SIN_TELEGRAM_NOTIFY_CHAT_ID) ||
    firstListValue(process.env.AGENT_SIN_TELEGRAM_CHAT_ID) ||
    firstListValue(process.env.AGENT_SIN_TELEGRAM_LISTEN_CHAT_IDS)
  );
}

function telegramNotifyThreadId(override?: string): string {
  return (
    firstListValue(override) ||
    firstListValue(process.env.AGENT_SIN_TELEGRAM_NOTIFY_THREAD_ID) ||
    firstListValue(process.env.AGENT_SIN_TELEGRAM_THREAD_ID)
  );
}

function firstListValue(value: string | undefined): string {
  return (value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function normalizeDiscordSnowflake(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : "";
}

function normalizeTelegramInteger(value: string): string {
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? trimmed : "";
}

function discordWebhookUrl(url: string, threadId: string): string {
  if (!threadId) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("thread_id", threadId);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}thread_id=${encodeURIComponent(threadId)}`;
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [""];
  if (trimmed.length <= maxLength) return [trimmed];
  const chunks: string[] = [];
  let current = "";
  for (const line of trimmed.split(/\r?\n/)) {
    if (current && current.length + line.length + 1 > maxLength) {
      chunks.push(current);
      current = "";
    }
    if (line.length > maxLength) {
      for (let index = 0; index < line.length; index += maxLength) {
        const piece = line.slice(index, index + maxLength);
        if (current) {
          chunks.push(current);
          current = "";
        }
        chunks.push(piece);
      }
      continue;
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function postDiscordChunks(
  chunks: string[],
  send: (chunk: string) => Promise<NotifyResult>,
): Promise<NotifyResult> {
  let sent = 0;
  for (const chunk of chunks) {
    const result = await send(chunk);
    if (!result.ok) {
      return sent > 0
        ? { channel: "discord", ok: false, detail: `sent ${sent}/${chunks.length}: ${result.detail || "failed"}` }
        : result;
    }
    sent += 1;
  }
  return { channel: "discord", ok: true, detail: chunks.length > 1 ? `${chunks.length} messages` : undefined };
}

async function postDiscordBotMessage(
  token: string,
  channelId: string,
  content: string,
): Promise<NotifyResult> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      const detail = `HTTP ${response.status} ${response.statusText}`.trim();
      return { channel: "discord", ok: false, detail };
    }
    return { channel: "discord", ok: true };
  } catch (error) {
    return {
      channel: "discord",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postTelegramChunks(
  chunks: string[],
  send: (chunk: string) => Promise<NotifyResult>,
): Promise<NotifyResult> {
  let sent = 0;
  for (const chunk of chunks) {
    const result = await send(chunk);
    if (!result.ok) {
      return sent > 0
        ? { channel: "telegram", ok: false, detail: `sent ${sent}/${chunks.length}: ${result.detail || "failed"}` }
        : result;
    }
    sent += 1;
  }
  return { channel: "telegram", ok: true, detail: chunks.length > 1 ? `${chunks.length} messages` : undefined };
}

async function postTelegramBotMessage(
  token: string,
  chatId: string,
  text: string,
  threadId: string,
): Promise<NotifyResult> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (threadId) {
      payload.message_thread_id = Number.parseInt(threadId, 10);
    }
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = `HTTP ${response.status} ${response.statusText}`.trim();
      return { channel: "telegram", ok: false, detail };
    }
    return { channel: "telegram", ok: true };
  } catch (error) {
    return {
      channel: "telegram",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postWebhook(
  url: string,
  payload: Record<string, unknown>,
  channel: NotifyChannel,
): Promise<NotifyResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = `HTTP ${response.status} ${response.statusText}`.trim();
      return { channel, ok: false, detail };
    }
    return { channel, ok: true };
  } catch (error) {
    return {
      channel,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function runChild(bin: string, args: string[], channel: NotifyChannel): Promise<NotifyResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({ channel, ok: false, detail: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ channel, ok: true });
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`;
      resolve({ channel, ok: false, detail });
    });
  });
}
