import { JiraIssue, ConfluencePage } from "./types";

const MAX_RESULTS = 1000;
const PAGE_SIZE = 100;

interface AtlassianAuth {
  domain: string;
  email: string;
  token: string;
}

interface ResolvedAuth extends AtlassianAuth {
  cloudId: string | null;
  useScoped: boolean;
}

const resolvedAuthCache = new Map<string, ResolvedAuth>();

function getAuth(
  overrideDomain?: string,
  overrideEmail?: string,
  overrideToken?: string
): AtlassianAuth | null {
  const domain = overrideDomain || process.env.ATLASSIAN_DOMAIN;
  const email = overrideEmail || process.env.ATLASSIAN_EMAIL;
  const token = overrideToken || process.env.ATLASSIAN_API_TOKEN;
  if (!domain || !email || !token) return null;
  const cleanDomain = domain.replace(/\.atlassian\.net\/?$/, "").replace(/^https?:\/\//, "");
  return { domain: cleanDomain, email, token };
}

function basicAuthHeader(auth: AtlassianAuth): string {
  return `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}`;
}

async function resolveAuth(auth: AtlassianAuth): Promise<ResolvedAuth> {
  const cacheKey = `${auth.domain}:${auth.email}:${auth.token.slice(0, 8)}`;
  const cached = resolvedAuthCache.get(cacheKey);
  if (cached) return cached;

  const classicRes = await fetch(`https://${auth.domain}.atlassian.net/rest/api/3/myself`, {
    headers: { Authorization: basicAuthHeader(auth), Accept: "application/json" },
  }).catch(() => null);

  if (classicRes?.ok) {
    const resolved: ResolvedAuth = { ...auth, cloudId: null, useScoped: false };
    resolvedAuthCache.set(cacheKey, resolved);
    console.log(`Atlassian: using classic auth for ${auth.domain}`);
    return resolved;
  }

  let cloudId: string | null = null;
  try {
    const tenantRes = await fetch(`https://${auth.domain}.atlassian.net/_edge/tenant_info`);
    if (tenantRes.ok) {
      const tenant = await tenantRes.json();
      cloudId = tenant.cloudId || null;
    }
  } catch { /* ignore */ }

  if (cloudId) {
    const scopedRes = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
      headers: { Authorization: basicAuthHeader(auth), Accept: "application/json" },
    }).catch(() => null);

    if (scopedRes?.ok) {
      const resolved: ResolvedAuth = { ...auth, cloudId, useScoped: true };
      resolvedAuthCache.set(cacheKey, resolved);
      console.log(`Atlassian: using scoped auth for ${auth.domain} (cloudId: ${cloudId})`);
      return resolved;
    }
  }

  const resolved: ResolvedAuth = { ...auth, cloudId, useScoped: false };
  resolvedAuthCache.set(cacheKey, resolved);
  console.warn(`Atlassian: auth resolution failed for ${auth.domain}, will attempt classic as fallback`);
  return resolved;
}

function jiraBaseUrl(auth: ResolvedAuth): string {
  if (auth.useScoped && auth.cloudId) {
    return `https://api.atlassian.com/ex/jira/${auth.cloudId}/rest/api/3`;
  }
  return `https://${auth.domain}.atlassian.net/rest/api/3`;
}

function confluenceBaseUrl(auth: ResolvedAuth): string {
  if (auth.useScoped && auth.cloudId) {
    return `https://api.atlassian.com/ex/confluence/${auth.cloudId}/wiki/rest/api`;
  }
  return `https://${auth.domain}.atlassian.net/wiki/rest/api`;
}

function parseFilterList(filter: string | undefined): string[] {
  if (!filter) return [];
  return filter.split(/[,;\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

function buildJiraJql(projectFilter: string | undefined): string {
  const projects = parseFilterList(projectFilter);
  if (projects.length === 0) return "ORDER BY updated DESC";
  const quoted = projects.map((p) => {
    const upper = p.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]+$/.test(upper)) return upper;
    return `"${p.trim().replace(/"/g, '\\"')}"`;
  });
  return `project IN (${quoted.join(", ")}) ORDER BY updated DESC`;
}

async function atlFetch(url: string, auth: ResolvedAuth): Promise<{ data: unknown; error: string | null }> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: basicAuthHeader(auth),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 401 || res.status === 403) {
        hint = auth.useScoped
          ? " — Scoped token may be missing required scopes (read:jira-work, read:confluence-content.all)"
          : " — Check that your email and API token are correct. If using a scoped token, ensure it has read permissions.";
      }
      const msg = `${res.status} ${res.statusText}${hint}${body ? ` — ${body.slice(0, 150)}` : ""}`;
      console.error(`Atlassian API error: ${msg} for ${url}`);
      return { data: null, error: msg };
    }
    return { data: await res.json(), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Connection failed";
    console.error(`Atlassian fetch error: ${msg} for ${url}`);
    return { data: null, error: msg };
  }
}

export async function getJiraIssues(
  overrideDomain?: string,
  overrideEmail?: string,
  overrideToken?: string,
  projectFilter?: string
): Promise<{ data: JiraIssue[]; isDemo: boolean; error?: string }> {
  const rawAuth = getAuth(overrideDomain, overrideEmail, overrideToken);
  if (!rawAuth) return { data: [], isDemo: false };

  const auth = await resolveAuth(rawAuth);
  const base = jiraBaseUrl(auth);
  const allIssues: JiraIssue[] = [];
  let startAt = 0;
  const jql = encodeURIComponent(buildJiraJql(projectFilter));
  let lastError: string | null = null;

  while (allIssues.length < MAX_RESULTS) {
    const { data, error } = await atlFetch(
      `${base}/search?jql=${jql}&maxResults=${PAGE_SIZE}&startAt=${startAt}&fields=summary,description,status,issuetype,priority,assignee,reporter,labels,created,updated,project,resolution`,
      auth
    );
    if (error) { lastError = error; break; }
    const result = data as Record<string, unknown>;
    const issues = result?.issues as Record<string, unknown>[];
    if (!issues) break;

    for (const issue of issues) {
      const f = (issue.fields || {}) as Record<string, unknown>;
      allIssues.push({
        id: issue.id as string,
        key: issue.key as string,
        summary: (f.summary as string) || "",
        description: extractTextFromADF(f.description),
        status: ((f.status as Record<string, unknown>)?.name as string) || "Unknown",
        issueType: ((f.issuetype as Record<string, unknown>)?.name as string) || "Unknown",
        priority: ((f.priority as Record<string, unknown>)?.name as string) || "Medium",
        assignee: ((f.assignee as Record<string, unknown>)?.displayName as string) || "Unassigned",
        reporter: ((f.reporter as Record<string, unknown>)?.displayName as string) || "",
        labels: (f.labels as string[]) || [],
        created: (f.created as string) || "",
        updated: (f.updated as string) || "",
        project: ((f.project as Record<string, unknown>)?.name as string) || ((f.project as Record<string, unknown>)?.key as string) || "",
        resolution: ((f.resolution as Record<string, unknown>)?.name as string) || "",
      });
    }

    const total = result?.total as number;
    if (issues.length < PAGE_SIZE || allIssues.length >= (total || MAX_RESULTS)) break;
    startAt += PAGE_SIZE;
  }

  const mode = auth.useScoped ? "scoped" : "classic";
  const filterDesc = projectFilter ? ` (filter: ${projectFilter})` : "";
  console.log(`Jira [${mode}]: fetched ${allIssues.length} issues${filterDesc}${lastError ? ` [error: ${lastError.slice(0, 80)}]` : ""}`);
  return { data: allIssues, isDemo: false, error: lastError || undefined };
}

export async function getConfluencePages(
  overrideDomain?: string,
  overrideEmail?: string,
  overrideToken?: string,
  spaceFilter?: string
): Promise<{ data: ConfluencePage[]; isDemo: boolean; error?: string }> {
  const rawAuth = getAuth(overrideDomain, overrideEmail, overrideToken);
  if (!rawAuth) return { data: [], isDemo: false };

  const auth = await resolveAuth(rawAuth);
  const base = confluenceBaseUrl(auth);
  const spaces = parseFilterList(spaceFilter);
  const allPages: ConfluencePage[] = [];
  const limit = 50;
  let lastError: string | null = null;

  async function fetchPages(spaceKey?: string) {
    let start = 0;
    const spaceParam = spaceKey ? `&spaceKey=${encodeURIComponent(spaceKey.toUpperCase())}` : "";
    while (allPages.length < 500) {
      const { data, error } = await atlFetch(
        `${base}/content?type=page${spaceParam}&orderby=lastmodified desc&limit=${limit}&start=${start}&expand=space,version,body.view`,
        auth
      );
      if (error) {
        lastError = error;
        if (spaceKey) {
          const { data: cqlData } = await atlFetch(
            `${base}/content/search?cql=${encodeURIComponent(`space.title = "${spaceKey}" ORDER BY lastmodified DESC`)}&limit=${limit}&expand=space,version,body.view`,
            auth
          );
          const results = (cqlData as Record<string, unknown>)?.results as Record<string, unknown>[];
          if (results) for (const page of results) addPage(allPages, page, auth.domain);
        }
        return;
      }
      const results = (data as Record<string, unknown>)?.results as Record<string, unknown>[];
      if (!results) break;
      for (const page of results) addPage(allPages, page, auth.domain);
      if (results.length < limit) break;
      start += limit;
    }
  }

  if (spaces.length > 0) {
    for (const space of spaces) await fetchPages(space);
  } else {
    await fetchPages();
  }

  const mode = auth.useScoped ? "scoped" : "classic";
  const filterDesc = spaceFilter ? ` (filter: ${spaceFilter})` : "";
  const errMsg = lastError ? ` [error: ${String(lastError).slice(0, 80)}]` : "";
  console.log(`Confluence [${mode}]: fetched ${allPages.length} pages${filterDesc}${errMsg}`);
  return { data: allPages, isDemo: false, error: lastError || undefined };
}

function addPage(allPages: ConfluencePage[], page: Record<string, unknown>, domain: string) {
  const bodyObj = page.body as Record<string, unknown> | undefined;
  const viewObj = bodyObj?.view as Record<string, unknown> | undefined;
  const body = (viewObj?.value as string) || "";
  const excerpt = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  const space = page.space as Record<string, unknown> | undefined;
  const version = page.version as Record<string, unknown> | undefined;
  const links = page._links as Record<string, unknown> | undefined;
  const by = version?.by as Record<string, unknown> | undefined;

  allPages.push({
    id: page.id as string,
    title: (page.title as string) || "Untitled",
    excerpt,
    space: (space?.name as string) || (space?.key as string) || "",
    lastModified: (version?.when as string) || "",
    author: (by?.displayName as string) || "",
    url: `https://${domain}.atlassian.net/wiki${(links?.webui as string) || ""}`,
  });
}

function extractTextFromADF(adf: unknown): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (typeof adf !== "object") return "";
  const node = adf as Record<string, unknown>;
  if (node.type === "text" && typeof node.text === "string") return node.text;
  let text = "";
  if (Array.isArray(node.content)) {
    for (const child of node.content) text += extractTextFromADF(child) + " ";
  }
  return text.trim();
}

export function isAtlassianConfigured(
  overrideDomain?: string,
  overrideEmail?: string,
  overrideToken?: string
): boolean {
  return !!getAuth(overrideDomain, overrideEmail, overrideToken);
}
