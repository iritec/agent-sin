import { l } from "./i18n.js";

const TEXT_EXT_PATTERN =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|yaml|yml|xml|html|css|js|jsx|ts|tsx|mjs|cjs|py|rb|php|java|kt|go|rs|swift|c|cc|cpp|h|hpp|sh|bash|zsh|fish|sql|toml|ini|env|log)$/i;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
  "application/csv",
  "application/vnd.ms-excel",
]);

export function cleanAttachmentText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u0000/g, "").trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxChars).trimEnd()}\n${l("... (omitted because it is long)", "...（長いため省略）")}`;
}

export function indentAttachmentContent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const kb = value / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

export function isTextLikeFile(contentType: string | undefined, filename: string | undefined): boolean {
  const normalizedType = (contentType || "").toLowerCase().split(";")[0].trim();
  if (normalizedType.startsWith("text/")) {
    return true;
  }
  if (TEXT_CONTENT_TYPES.has(normalizedType)) {
    return true;
  }
  return TEXT_EXT_PATTERN.test((filename || "").toLowerCase());
}

export function isImageLikeFile(contentType: string | undefined, filename: string | undefined): boolean {
  const normalizedType = (contentType || "").toLowerCase().split(";")[0].trim();
  if (normalizedType.startsWith("image/")) {
    return true;
  }
  return IMAGE_EXT_PATTERN.test((filename || "").toLowerCase());
}

export function guessImageMimeType(filename: string | undefined): string {
  const normalized = (filename || "").toLowerCase();
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".bmp")) return "image/bmp";
  if (normalized.endsWith(".heic")) return "image/heic";
  if (normalized.endsWith(".heif")) return "image/heif";
  return "image/png";
}

export function formatAttachmentLabel(input: {
  name: string | undefined;
  fallback: string;
  contentType?: string;
  size?: number;
}): string {
  const name = cleanAttachmentText(input.name || input.fallback, 200);
  const meta = [
    input.contentType ? cleanAttachmentText(input.contentType, 120) : "",
    typeof input.size === "number" ? formatBytes(input.size) : "",
  ].filter(Boolean);
  return meta.length > 0 ? `${name} (${meta.join(", ")})` : name;
}

export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < Math.floor(max / 2)) {
      cut = max;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  return chunks;
}
