/**
 * Terminal spinner used during long-running operations such as model calls
 * and skill execution. Mimics the "<frame> <label> (Ns)" style seen in
 * Claude Code and Codex CLI. Renders only on a real TTY where carriage
 * return ('\r') overwrites work; in CI, KingCoding terminals, or when
 * NO_SPINNER is set we fall back to a single status line so output stays
 * clean.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 100;
const CLEAR_LINE = "\r\x1b[2K";
const BRAND_GREEN_ANSI = "38;2;24;160;104";

export interface SpinnerOptions {
  stream?: NodeJS.WriteStream;
  forceEnabled?: boolean;
}

function detectAnimationDisabled(): boolean {
  if (process.env.AGENT_SIN_NO_SPINNER === "1") return true;
  if (process.env.NO_SPINNER === "1") return true;
  if (process.env.CI && process.env.CI !== "0" && process.env.CI !== "false") return true;
  if (process.env.TERM === "dumb") return true;
  // KingCoding runs agent-sin inside its own terminal that doesn't honor '\r'
  // overwrites — every spinner tick would render as a new line.
  if (process.env.KINGCODING_RUNTIME_CHANNEL) return true;
  if ((process.env.APP_DATA_DIR || "").includes("KingCoding")) return true;
  return false;
}

export class Spinner {
  private readonly stream: NodeJS.WriteStream;
  private readonly animated: boolean;
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private label = "";
  private startTime = 0;
  private staticPrinted = false;

  constructor(options: SpinnerOptions = {}) {
    this.stream = options.stream || process.stderr;
    const isTTY = this.stream.isTTY === true;
    const animationDisabled = detectAnimationDisabled();
    this.animated = options.forceEnabled ?? (isTTY && !animationDisabled);
    this.enabled = this.animated || isTTY;
  }

  start(label: string): void {
    this.label = label;
    this.startTime = Date.now();
    this.frameIndex = 0;
    this.staticPrinted = false;
    if (this.animated) {
      this.render();
      this.timer = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
        this.render();
      }, FRAME_INTERVAL_MS);
      if (typeof this.timer.unref === "function") {
        this.timer.unref();
      }
      return;
    }
    if (this.enabled) {
      this.stream.write(`${label}…\n`);
      this.staticPrinted = true;
    }
  }

  update(label: string): void {
    if (this.label === label) {
      return;
    }
    this.label = label;
    if (this.animated && this.timer) {
      this.render();
    }
    // In static (non-animated) mode we deliberately drop progress updates
    // to keep the output to a single status line per operation.
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.animated) {
      this.stream.write(CLEAR_LINE);
    }
    this.staticPrinted = false;
  }

  /** Stop the spinner and emit a final status line on its own line. */
  finish(message: string): void {
    this.stop();
    if (this.enabled && message) {
      this.stream.write(`${message}\n`);
    }
  }

  isActive(): boolean {
    return this.timer !== null || this.staticPrinted;
  }

  private render(): void {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const frame = FRAMES[this.frameIndex];
    const useColor = this.enabled && !process.env.NO_COLOR;
    const paint = (codes: string, text: string): string =>
      useColor ? `\x1b[${codes}m${text}\x1b[0m` : text;
    const elapsedText = ` (${elapsed}s)`;
    // Truncate the label so the rendered line never exceeds the terminal
    // width. Without this, long progress labels (e.g. streamed thinking text)
    // wrap to the next line and the spinner's '\r' overwrite stops working,
    // leaving every frame stacked on screen.
    const columns = this.stream.columns || 80;
    const reserved = 2 /* frame + space */ + elapsedText.length + 1 /* safety */;
    const maxDisplayWidth = Math.max(10, columns - reserved);
    const labelText = truncateToDisplayWidth(this.label, maxDisplayWidth);
    const head = paint(BRAND_GREEN_ANSI, frame);
    const body = paint("90", `${labelText}${elapsedText}`);
    this.stream.write(`${CLEAR_LINE}${head} ${body}`);
  }
}

function charDisplayWidth(codePoint: number): number {
  // Treat full-width / wide code points (CJK, kana, full-width forms,
  // emoji) as 2 columns; everything else as 1. Heuristic ranges that
  // cover the common cases without pulling in a wcwidth library.
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2;
  if (codePoint >= 0x2e80 && codePoint <= 0x303e) return 2;
  if (codePoint >= 0x3041 && codePoint <= 0x33ff) return 2;
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return 2;
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return 2;
  if (codePoint >= 0xa000 && codePoint <= 0xa4cf) return 2;
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2;
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2;
  if (codePoint >= 0xfe30 && codePoint <= 0xfe4f) return 2;
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2;
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
  if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return 2;
  if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return 2;
  return 1;
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let width = 0;
  let result = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const w = charDisplayWidth(codePoint);
    if (width + w > maxWidth - 1) {
      return `${result}…`;
    }
    width += w;
    result += char;
  }
  return result;
}
