import type { RouteContext } from "./types.js";
import {
  installGitHubSkill,
  searchGitHubSkills,
} from "../../skill-github.js";
import {
  deleteSkill,
  saveSkill,
} from "../../skill-library.js";
import {
  readJson,
  sendJson,
} from "./http.js";
import {
  optionalString,
  requiredSkillScope,
  requiredString,
} from "./validation.js";

// The skill library: saving, deleting and installing skills from GitHub.

export async function routeGetSkillsGithubSearch(ctx: RouteContext): Promise<void> {
  const { res, url } = ctx;
  const results = await searchGitHubSkills(String(url.query.q ?? ""));
  sendJson(res, 200, { results });
  return;
}

export async function routePostSkillsGithubInstall(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const skill = await installGitHubSkill({
    repository: requiredString(body.repository, "repository"),
    path: requiredString(body.path, "path"),
    ref: optionalString(body.ref),
    scope: requiredSkillScope(body.scope),
    overwrite: body.overwrite === true,
  }, cwd);
  sendJson(res, 200, { skill });
  return;
}

export async function routePostSkillsSave(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const scope = requiredSkillScope(body.scope);
  const skill = saveSkill({
    scope,
    name: optionalString(body.name),
    description: optionalString(body.description),
    content: requiredString(body.content, "content"),
  }, cwd);
  sendJson(res, 200, { skill });
  return;
}

export async function routePostSkillsDelete(ctx: RouteContext): Promise<void> {
  const { req, res, cwd } = ctx;
  const body = await readJson(req);
  const scope = requiredSkillScope(body.scope);
  const name = requiredString(body.name, "name");
  const deleted = deleteSkill(scope, name, cwd);
  if (!deleted) sendJson(res, 404, { error: "Skill not found." });
  else sendJson(res, 200, { deleted: true });
  return;
}
