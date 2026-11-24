import { listSkills } from "../../skill-library.js";

const skillCache = new Map<string, { expires: number; value: ReturnType<typeof listSkills> }>();

export function dashboardSkills(cwd: string): ReturnType<typeof listSkills> {
  const key = `${cwd}\0${process.env.AGENT_BRIDGE_HOME ?? ""}\0${process.env.HOME ?? ""}\0${process.env.USERPROFILE ?? ""}`;
  const cached = skillCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = [...listSkills("repo", cwd), ...listSkills("global", cwd)];
  if (skillCache.size >= 32) skillCache.delete(skillCache.keys().next().value!);
  skillCache.set(key, { expires: Date.now() + 10000, value });
  return value;
}

export function invalidateDashboardSkills(): void { skillCache.clear(); }
