import { posix } from "node:path";
import { installSkillFiles, type SkillFile, type SkillRecord, type SkillScope } from "./skill-library.js";

export type GitHubSkillSearchResult = {
  repository: string;
  repositoryUrl: string;
  description: string;
  stars: number;
  updatedAt: string;
  path: string;
  ref: string;
  skillUrl: string;
};

type GitHubClientOptions = {
  fetchImpl?: typeof fetch;
  token?: string;
};

type GitHubContent = {
  type?: string;
  name?: string;
  path?: string;
  size?: number;
  url?: string;
  content?: string;
  encoding?: string;
};

type GitHubRepositoryMetadata = {
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string | null;
  updated_at?: string | null;
  default_branch?: string;
  html_url?: string;
};

const GITHUB_API = "https://api.github.com";
export const GITHUB_TOKEN_MISSING_MESSAGE =
  "GitHub token is not visible to the running Agent Bridge process. Set GITHUB_TOKEN or GH_TOKEN in the terminal that starts Agent Bridge, then restart it.";

export async function searchGitHubSkills(
  queryValue: string,
  options: GitHubClientOptions = {},
): Promise<GitHubSkillSearchResult[]> {
  const query = queryValue.trim();
  if (query.length < 2) throw new Error("Enter at least 2 characters to search GitHub skills.");
  if (query.length > 100) throw new Error("GitHub skill search must not exceed 100 characters.");
  if (!resolveGitHubToken(options)) throw new Error(GITHUB_TOKEN_MISSING_MESSAGE);
  const params = new URLSearchParams({ q: `${query} filename:SKILL.md`, per_page: "20" });
  const data = await githubJson(`${GITHUB_API}/search/code?${params}`, options) as {
    items?: Array<{
      path?: string;
      url?: string;
      html_url?: string;
      repository?: { full_name?: string; html_url?: string; default_branch?: string };
    }>;
  };
  const matches = (data.items ?? []).flatMap((item, searchRank) => {
    const repository = item.repository?.full_name;
    if (!repository || !isRepository(repository) || !item.path) return [];
    const path = normalizeGitHubPath(item.path);
    if (posix.basename(path).toLowerCase() !== "skill.md") return [];
    return [{
      repository,
      repositoryUrl: item.repository?.html_url ?? `https://github.com/${repository}`,
      path,
      ref: item.repository?.default_branch ?? "HEAD",
      skillUrl: item.html_url ?? `https://github.com/${repository}/blob/HEAD/${path}`,
      apiUrl: item.url,
      searchRank,
    }];
  });
  const repositories = [...new Set(matches.map((match) => match.repository))];
  const metadata = new Map<string, GitHubRepositoryMetadata>();
  for (let offset = 0; offset < repositories.length; offset += 5) {
    const batch = repositories.slice(offset, offset + 5);
    const entries = await Promise.all(batch.map(async (repository) => [
      repository,
      await githubJson(`${GITHUB_API}/repos/${repository}`, options),
    ] as const));
    for (const [repository, details] of entries) metadata.set(repository, details as GitHubRepositoryMetadata);
  }
  const skillMarkdown = new Map<string, string>();
  for (let offset = 0; offset < matches.length; offset += 5) {
    const batch = matches.slice(offset, offset + 5);
    const entries = await Promise.all(batch.map(async (match) => [
      `${match.repository}:${match.path}`,
      await fetchSearchSkillMarkdown(match.repository, match.path, match.ref, match.apiUrl, options),
    ] as const));
    for (const [key, markdown] of entries) skillMarkdown.set(key, markdown);
  }
  const ranked = matches.map((match) => {
    const details = metadata.get(match.repository);
    const description = details?.description?.trim() ?? "";
    return {
      ...match,
      repositoryUrl: details?.html_url ?? match.repositoryUrl,
      description,
      stars: Number.isFinite(details?.stargazers_count) ? Math.max(0, Math.floor(details!.stargazers_count!)) : 0,
      updatedAt: details?.pushed_at ?? details?.updated_at ?? "",
      ref: details?.default_branch ?? match.ref,
      relevance: searchRelevance(
        query,
        match.repository,
        match.path,
        description,
        skillMarkdown.get(`${match.repository}:${match.path}`) ?? "",
      ),
    };
  }).sort((left, right) => {
    const relevance = right.relevance - left.relevance;
    if (relevance) return relevance;
    // With no lexical signal, preserve GitHub's code-search ranking instead
    // of letting a popular but unrelated repository jump to the top.
    if (left.relevance === 0 && left.searchRank !== right.searchRank) {
      return left.searchRank - right.searchRank;
    }
    return right.stars - left.stars ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.searchRank - right.searchRank ||
    left.repository.localeCompare(right.repository) ||
    left.path.localeCompare(right.path);
  });
  return ranked.map(({ relevance: _relevance, searchRank: _searchRank, apiUrl: _apiUrl, ...result }) => result);
}

async function fetchSearchSkillMarkdown(
  repository: string,
  path: string,
  ref: string,
  apiUrl: string | undefined,
  options: GitHubClientOptions,
): Promise<string> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = apiUrl ?? `${GITHUB_API}/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  try {
    const detail = await githubJson(url, options) as GitHubContent;
    if (detail.encoding !== "base64" || typeof detail.content !== "string") return "";
    return Buffer.from(detail.content.replace(/\s/g, ""), "base64").toString("utf8");
  } catch {
    // Repository metadata still provides a useful fallback when a result's file
    // is removed, too large for the Contents API, or temporarily unavailable.
    return "";
  }
}

function searchRelevance(
  query: string,
  repository: string,
  path: string,
  description: string,
  markdown: string,
): number {
  const phrase = normalizeSearchText(query);
  const terms = [...new Set(phrase.split(" ").filter((term) => term.length >= 2))];
  const skill = skillSearchFields(markdown);
  const fields = [
    { value: normalizeSearchText(skill.name), phrase: 32, term: 10 },
    { value: normalizeSearchText(skill.description), phrase: 26, term: 8 },
    { value: normalizeSearchText(skill.heading), phrase: 22, term: 7 },
    { value: normalizeSearchText(path), phrase: 16, term: 5 },
    { value: normalizeSearchText(repository), phrase: 12, term: 4 },
    { value: normalizeSearchText(description), phrase: 10, term: 3 },
    { value: normalizeSearchText(skill.body), phrase: 8, term: 2 },
  ];
  let score = 0;
  for (const field of fields) {
    if (phrase && field.value.includes(phrase)) score += field.phrase;
    const words = field.value.split(" ");
    for (const term of terms) if (words.some((word) => searchWordMatches(term, word))) score += field.term;
  }
  const combinedWords = fields.flatMap((field) => field.value.split(" "));
  const matchedTerms = terms.filter((term) => combinedWords.some((word) => searchWordMatches(term, word))).length;
  if (terms.length > 1 && matchedTerms === terms.length) score += 16;
  else if (terms.length > 2 && matchedTerms / terms.length >= 0.66) score += 8;
  return score;
}

function skillSearchFields(markdown: string): { name: string; description: string; heading: string; body: string } {
  const frontmatter = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const readField = (name: string): string => {
    const value = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
    return value.replace(/^["']|["']$/g, "");
  };
  return {
    name: readField("name"),
    description: readField("description"),
    heading: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "",
    body: markdown.slice(0, 100_000),
  };
}

function searchWordMatches(term: string, word: string): boolean {
  if (term === word) return true;
  return term.length >= 4 && word.length >= 4 && (word.startsWith(term) || term.startsWith(word));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function installGitHubSkill(
  input: {
    repository: string;
    path: string;
    ref?: string;
    scope: SkillScope;
    overwrite?: boolean;
  },
  cwd: string,
  options: GitHubClientOptions & { userHome?: string } = {},
): Promise<SkillRecord> {
  if (!isRepository(input.repository)) throw new Error("Invalid GitHub repository.");
  const skillPath = normalizeGitHubPath(input.path);
  if (posix.basename(skillPath).toLowerCase() !== "skill.md") {
    throw new Error("GitHub skill path must point to SKILL.md.");
  }
  const ref = (input.ref ?? "HEAD").trim();
  if (!ref || ref.length > 255 || /[\0\r\n]/.test(ref)) throw new Error("Invalid GitHub ref.");
  const directory = posix.dirname(skillPath);
  const rootDirectory = directory === "." ? "" : directory;
  const files: SkillFile[] = [];
  await downloadDirectory(input.repository, rootDirectory, rootDirectory, ref, files, options);
  return installSkillFiles({
    scope: input.scope,
    files,
    overwrite: input.overwrite,
  }, cwd, options.userHome);
}

async function downloadDirectory(
  repository: string,
  directory: string,
  rootDirectory: string,
  ref: string,
  files: SkillFile[],
  options: GitHubClientOptions,
): Promise<void> {
  if (files.length > 128) throw new Error("GitHub skill contains too many files (maximum 128).");
  const encodedPath = directory.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${repository}/contents${encodedPath ? `/${encodedPath}` : ""}?ref=${encodeURIComponent(ref)}`;
  const listing = await githubJson(url, options);
  if (!Array.isArray(listing)) throw new Error("The selected GitHub skill path is not a directory.");
  for (const item of listing as GitHubContent[]) {
    if (item.type === "dir") {
      await downloadDirectory(repository, normalizeGitHubPath(item.path ?? ""), rootDirectory, ref, files, options);
      continue;
    }
    if (item.type !== "file" || !item.url || !item.path) {
      throw new Error(`Unsupported GitHub skill entry: ${item.name ?? "unknown"}.`);
    }
    if ((item.size ?? 0) > 2 * 1024 * 1024) {
      throw new Error(`GitHub skill file ${item.path} exceeds 2 MB.`);
    }
    const detail = await githubJson(item.url, options) as GitHubContent;
    if (detail.encoding !== "base64" || typeof detail.content !== "string") {
      throw new Error(`GitHub did not return file content for ${item.path}.`);
    }
    const fullPath = normalizeGitHubPath(item.path);
    const relativePath = rootDirectory
      ? posix.relative(rootDirectory, fullPath)
      : fullPath;
    files.push({ path: relativePath, content: Buffer.from(detail.content.replace(/\s/g, ""), "base64") });
    if (files.length > 128) throw new Error("GitHub skill contains too many files (maximum 128).");
  }
}

async function githubJson(url: string, options: GitHubClientOptions): Promise<unknown> {
  const token = resolveGitHubToken(options);
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-bridge-skills",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const data = await response.json().catch(() => undefined) as { message?: string } | undefined;
  if (!response.ok) {
    if (response.status === 401 && !token) throw new Error(GITHUB_TOKEN_MISSING_MESSAGE);
    const authentication = response.status === 401 ? " Check that the configured GitHub token is valid." : "";
    throw new Error(`GitHub request failed (${response.status}): ${data?.message ?? response.statusText}.${authentication}`);
  }
  return data;
}

function resolveGitHubToken(options: GitHubClientOptions): string | undefined {
  const value = options.token !== undefined
    ? options.token
    : process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return value?.trim() || undefined;
}

function normalizeGitHubPath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new Error("Invalid GitHub skill path.");
  }
  const normalized = posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) throw new Error("Invalid GitHub skill path.");
  return normalized;
}

function isRepository(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
