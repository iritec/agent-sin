import { type AppConfig, loadModels, type ModelConfig } from "./config.js";
import { listSkillManifests } from "./skill-registry.js";
import { l } from "./i18n.js";

export async function skillsLines(config: AppConfig): Promise<string[]> {
  const skills = await listSkillManifests(config.skills_dir);
  if (skills.length === 0) {
    return [l("No skills registered.", "登録済みのスキルはありません。")];
  }
  return skills.map((skill) => {
    const enabled = skill.enabled === false ? l("disabled", "無効") : l("enabled", "有効");
    const source = skill.source === "builtin" ? l("builtin", "ビルトイン") : skill.override ? l("override", "上書き") : l("user", "ユーザー");
    return `${skill.id}\t${skill.name}\t${enabled}\t${source}`;
  });
}

export async function modelsLines(config: AppConfig): Promise<string[]> {
  const models = await loadModels(config.workspace);
  const chatId = config.chat_model_id;
  const builderId = config.builder_model_id;
  return Object.entries(models.models).map(([id, model]) => formatModelRow(id, model, chatId, builderId));
}

export function formatModelRow(
  id: string,
  model: ModelConfig["models"][string],
  chatId: string,
  builderId: string,
): string {
  const provider = model.provider || (model.type === "api" ? id : model.type);
  const name = model.model || "-";
  const effort = model.effort || "-";
  const enabled = model.enabled ? l("enabled", "有効") : l("disabled", "無効");
  const tags: string[] = [];
  if (id === chatId) tags.push("chat");
  if (id === builderId) tags.push("builder");
  const tag = tags.length ? `← ${tags.join(",")}` : "";
  return `${provider.padEnd(12)} ${name.padEnd(18)} ${effort.padEnd(8)} ${enabled.padEnd(8)} ${tag}`.trimEnd();
}

export function modelSummary(id: string, model: ModelConfig["models"][string]): string {
  const provider = model.provider || (model.type === "api" ? id : model.type);
  const name = model.model || "-";
  const effort = model.effort && model.effort !== "-" ? ` ${model.effort}` : "";
  return `${provider} ${name}${effort}`;
}
