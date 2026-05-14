import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { mkdir, stat, writeFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { l } from "./i18n.js";

const execFileAsync = promisify(execFile);

export const SERVICE_LABEL_DARWIN = "com.agent-sin.gateway";
export const SERVICE_TASK_NAME_WINDOWS = "Agent-Sin Gateway";
const SERVICE_STOP_TIMEOUT_MS = 10_000;
const SERVICE_BOOTSTRAP_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 3000];

export interface ServiceStatusInfo {
  installed: boolean;
  manifestPath: string;
  manifestKind: "plist" | "schtasks" | "none";
}

export interface ServiceProvider {
  readonly platformId: "darwin" | "windows" | "unsupported";
  readonly label: string;
  readonly supported: boolean;
  install(config: AppConfig, options?: { noStart?: boolean }): Promise<void>;
  start(config: AppConfig): Promise<void>;
  stop(options?: { quiet?: boolean; wait?: boolean }): Promise<void>;
  manifestText(config: AppConfig): string;
  status(config: AppConfig): Promise<ServiceStatusInfo>;
  notSupportedReason(): string;
}

export function renderServiceManifestForPlatform(
  config: AppConfig,
  platform: NodeJS.Platform = process.platform,
): { label: string; manifestKind: "plist" | "schtasks"; text: string } {
  if (platform === "win32") {
    return {
      label: SERVICE_TASK_NAME_WINDOWS,
      manifestKind: "schtasks",
      text: windowsTaskXml(config),
    };
  }
  return {
    label: SERVICE_LABEL_DARWIN,
    manifestKind: "plist",
    text: launchdPlistText(config),
  };
}

export function getServiceProvider(): ServiceProvider {
  if (process.platform === "darwin") {
    return darwinProvider;
  }
  if (process.platform === "win32") {
    return windowsProvider;
  }
  return unsupportedProvider;
}

export function serviceLabel(): string {
  if (process.platform === "win32") return SERVICE_TASK_NAME_WINDOWS;
  return SERVICE_LABEL_DARWIN;
}

function cliPath(): string {
  return path.resolve(process.argv[1] || "agent-sin");
}

function envPath(): string {
  if (process.platform === "win32") {
    return process.env.PATH || "";
  }
  return process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
}

function execErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
    const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
    const message = typeof record.message === "string" ? record.message.trim() : "";
    return stderr || stdout || message || String(error);
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function configLocaleEnv(config: AppConfig): string | undefined {
  const locale = config.defaults?.locale;
  return locale === "ja" || locale === "en" ? locale : undefined;
}

// ---------- darwin (launchd) ----------

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  return `gui/${uid}`;
}

function launchdServiceTarget(): string {
  return `${launchdDomain()}/${SERVICE_LABEL_DARWIN}`;
}

function launchdPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL_DARWIN}.plist`);
}

function launchdPlistText(config: AppConfig): string {
  const stdout = path.join(config.logs_dir, "service.out.log");
  const stderr = path.join(config.logs_dir, "service.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(SERVICE_LABEL_DARWIN)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(cliPath())}</string>
    <string>service</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_SIN_HOME</key>
    <string>${xmlEscape(config.workspace)}</string>
    <key>PATH</key>
    <string>${xmlEscape(envPath())}</string>${
      configLocaleEnv(config) ? `
    <key>AGENT_SIN_LOCALE</key>
    <string>${xmlEscape(configLocaleEnv(config)!)}</string>` : ""
    }
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.workspace)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
</dict>
</plist>`;
}

async function launchctl(
  args: string[],
  options: { allowAlreadyBootstrapped?: boolean; allowNotFound?: boolean } = {},
): Promise<void> {
  try {
    await execFileAsync("launchctl", args);
  } catch (error) {
    const detail = execErrorText(error);
    if (
      options.allowAlreadyBootstrapped &&
      /already exists|already bootstrapped|service already loaded|EEXIST/i.test(detail)
    ) {
      return;
    }
    if (options.allowNotFound && /No such process|Could not find service|service not found|113:/.test(detail)) {
      return;
    }
    throw new Error(l(`launchctl ${args.join(" ")} failed: ${detail}`, `launchctl ${args.join(" ")} が失敗しました: ${detail}`));
  }
}

async function isLaunchdServiceLoaded(target: string): Promise<boolean> {
  try {
    await execFileAsync("launchctl", ["print", target]);
    return true;
  } catch {
    return false;
  }
}

function isTransientBootstrapFailure(detail: string): boolean {
  return /Bootstrap failed:\s*5:|Input\/output error/i.test(detail);
}

async function bootstrapLaunchAgent(domain: string, plistPath: string, target: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt <= SERVICE_BOOTSTRAP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await launchctl(["bootstrap", domain, plistPath]);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (await isLaunchdServiceLoaded(target)) {
        return;
      }
      if (!isTransientBootstrapFailure(lastError) || attempt === SERVICE_BOOTSTRAP_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(SERVICE_BOOTSTRAP_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error(lastError);
}

async function waitForLaunchdServiceUnloaded(target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await isLaunchdServiceLoaded(target)) {
    if (Date.now() >= deadline) {
      throw new Error(l(`launchctl bootout ${target} timed out waiting for service to unload`, `launchctl bootout ${target} は service 停止待ちでタイムアウトしました`));
    }
    await sleep(250);
  }
}

const darwinProvider: ServiceProvider = {
  platformId: "darwin",
  label: SERVICE_LABEL_DARWIN,
  supported: true,
  async install(config, options) {
    const plistPath = launchdPlistPath();
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, launchdPlistText(config), "utf8");
    if (!options?.noStart) {
      await this.start(config);
    }
  },
  async start(_config) {
    const plistPath = launchdPlistPath();
    try {
      await stat(plistPath);
    } catch {
      throw new Error(l("service is not installed. Run: agent-sin service install", "service がインストールされていません。実行: agent-sin service install"));
    }
    const target = launchdServiceTarget();
    await bootstrapLaunchAgent(launchdDomain(), plistPath, target);
    await launchctl(["kickstart", "-k", target]);
  },
  async stop(options) {
    const target = launchdServiceTarget();
    await launchctl(["bootout", target], { allowNotFound: true });
    if (options?.wait) {
      await waitForLaunchdServiceUnloaded(target, SERVICE_STOP_TIMEOUT_MS);
    }
  },
  manifestText(config) {
    return launchdPlistText(config);
  },
  async status(_config) {
    const plistPath = launchdPlistPath();
    let installed = false;
    try {
      await stat(plistPath);
      installed = true;
    } catch {
      installed = false;
    }
    return { installed, manifestPath: plistPath, manifestKind: "plist" };
  },
  notSupportedReason() {
    return "";
  },
};

// ---------- windows (schtasks) ----------

function windowsManifestPath(): string {
  return path.join(os.homedir(), ".agent-sin", "service", "agent-sin-gateway.xml");
}

function windowsTaskXml(config: AppConfig): string {
  const cli = cliPath();
  const node = process.execPath;
  const args = [cli, "service", "run"]
    .map((value) => `"${value.replace(/"/g, '\\"')}"`)
    .join(" ");
  // Windows Task Scheduler uses UTF-16 LE XML. Build a logical XML; we'll save it as UTF-16 LE separately.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent-Sin Gateway: scheduler + Discord/Telegram bots</Description>
    <Author>agent-sin</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(node)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(config.workspace)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

async function schtasks(
  args: string[],
  options: { allowMissing?: boolean; allowExists?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("schtasks", args, { encoding: "utf8" });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const detail = execErrorText(error);
    if (options.allowMissing && /ERROR:\s*The system cannot find the file|cannot find the (?:file|task) specified/i.test(detail)) {
      return { stdout: "", stderr: detail };
    }
    if (options.allowExists && /ERROR:\s*Cannot create a file when that file already exists|already exists/i.test(detail)) {
      return { stdout: "", stderr: detail };
    }
    throw new Error(l(`schtasks ${args.join(" ")} failed: ${detail}`, `schtasks ${args.join(" ")} が失敗しました: ${detail}`));
  }
}

async function schtasksTaskInstalled(): Promise<boolean> {
  try {
    await execFileAsync("schtasks", ["/Query", "/TN", SERVICE_TASK_NAME_WINDOWS]);
    return true;
  } catch {
    return false;
  }
}

async function writeUtf16LeWithBom(filePath: string, text: string): Promise<void> {
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(text, "utf16le");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.concat([bom, body]));
}

const windowsProvider: ServiceProvider = {
  platformId: "windows",
  label: SERVICE_TASK_NAME_WINDOWS,
  supported: true,
  async install(config, options) {
    const xmlPath = windowsManifestPath();
    await writeUtf16LeWithBom(xmlPath, windowsTaskXml(config));
    // Replace existing task if any.
    if (await schtasksTaskInstalled()) {
      await schtasks(["/Delete", "/TN", SERVICE_TASK_NAME_WINDOWS, "/F"], { allowMissing: true });
    }
    await schtasks(["/Create", "/TN", SERVICE_TASK_NAME_WINDOWS, "/XML", xmlPath, "/F"]);
    if (!options?.noStart) {
      await this.start(config);
    }
  },
  async start(_config) {
    if (!(await schtasksTaskInstalled())) {
      throw new Error(l("service is not installed. Run: agent-sin service install", "service がインストールされていません。実行: agent-sin service install"));
    }
    await schtasks(["/Run", "/TN", SERVICE_TASK_NAME_WINDOWS]);
  },
  async stop(options) {
    if (!(await schtasksTaskInstalled())) {
      if (!options?.quiet) {
        // No installed task is not an error for stop.
      }
      return;
    }
    await schtasks(["/End", "/TN", SERVICE_TASK_NAME_WINDOWS], { allowMissing: true });
    if (options?.wait) {
      const deadline = Date.now() + SERVICE_STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!(await isWindowsTaskRunning())) {
          return;
        }
        await sleep(250);
      }
    }
  },
  manifestText(config) {
    return windowsTaskXml(config);
  },
  async status(_config) {
    const installed = await schtasksTaskInstalled();
    return {
      installed,
      manifestPath: windowsManifestPath(),
      manifestKind: "schtasks",
    };
  },
  notSupportedReason() {
    return "";
  },
};

async function isWindowsTaskRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "schtasks",
      ["/Query", "/TN", SERVICE_TASK_NAME_WINDOWS, "/FO", "CSV", "/NH"],
      { encoding: "utf8" },
    );
    const text = String(stdout).trim();
    if (!text) return false;
    const lines = text.split(/\r?\n/);
    return lines.some((line) => /"Running"/i.test(line));
  } catch {
    return false;
  }
}

// ---------- unsupported ----------

const unsupportedProvider: ServiceProvider = {
  platformId: "unsupported",
  label: SERVICE_LABEL_DARWIN,
  supported: false,
  async install() {
    throw new Error(this.notSupportedReason());
  },
  async start() {
    throw new Error(this.notSupportedReason());
  },
  async stop() {
    throw new Error(this.notSupportedReason());
  },
  manifestText(_config) {
    return "";
  },
  async status(_config) {
    return { installed: false, manifestPath: "", manifestKind: "none" };
  },
  notSupportedReason() {
    return l(
      `agent-sin service is not supported on ${process.platform}. Supported: macOS (launchd), Windows (Task Scheduler).`,
      `agent-sin service は ${process.platform} では未対応です。対応: macOS (launchd), Windows (Task Scheduler)。`,
    );
  },
};

// ---------- process discovery (cross-platform) ----------

export async function findAgentSinServiceProcesses(): Promise<string[]> {
  if (process.platform === "win32") {
    return findAgentSinServiceProcessesWindows();
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    const currentPid = String(process.pid);
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith(currentPid))
      .filter((line) => isServiceCommandLine(line));
  } catch {
    return [];
  }
}

async function findAgentSinServiceProcessesWindows(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "wmic",
      ["process", "where", "name='node.exe'", "get", "ProcessId,CommandLine", "/FORMAT:LIST"],
      { encoding: "utf8" },
    );
    const text = String(stdout);
    const lines: string[] = [];
    let currentCommand = "";
    let currentPid = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("CommandLine=")) {
        currentCommand = line.slice("CommandLine=".length);
      } else if (line.startsWith("ProcessId=")) {
        currentPid = line.slice("ProcessId=".length);
      } else if (line === "") {
        if (currentCommand && currentPid && currentPid !== String(process.pid)) {
          if (isServiceCommandLine(currentCommand)) {
            lines.push(`${currentPid} ${currentCommand}`);
          }
        }
        currentCommand = "";
        currentPid = "";
      }
    }
    if (currentCommand && currentPid && currentPid !== String(process.pid) && isServiceCommandLine(currentCommand)) {
      lines.push(`${currentPid} ${currentCommand}`);
    }
    return lines;
  } catch {
    return [];
  }
}

export function isServiceCommandLine(line: string): boolean {
  return (
    isSchedulerCommandLine(line) ||
    /\b(?:agent-sin|dist[\\/]cli[\\/]index\.js)\s+discord(?:\s|$)/.test(line) ||
    /\b(?:agent-sin|dist[\\/]cli[\\/]index\.js)\s+telegram(?:\s|$)/.test(line)
  );
}

export function isSchedulerCommandLine(line: string): boolean {
  return (
    /\b(?:agent-sin|dist[\\/]cli[\\/]index\.js)\s+(?:daemon|gateway)(?:\s|$)/.test(line) ||
    /\b(?:agent-sin|dist[\\/]cli[\\/]index\.js)\s+service\s+run(?:\s|$)/.test(line)
  );
}

export async function isSchedulerProcessRunning(): Promise<boolean> {
  return (await findAgentSinServiceProcesses()).some((line) => isSchedulerCommandLine(line));
}
