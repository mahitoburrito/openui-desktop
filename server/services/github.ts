// GitHub Issues Integration (no auth required for public repos)

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  url: string;
  state: string;
  labels: { name: string; color: string }[];
  assignee?: { login: string };
  created_at: string;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
  }
  return null;
}

export async function fetchGitHubIssues(
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open"
): Promise<GitHubIssue[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=50`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "OpenUI-Desktop",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const data: any = await res.json();

  return data
    .filter((item: any) => !item.pull_request)
    .map((issue: any) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
      labels: issue.labels.map((l: any) => ({ name: l.name, color: l.color })),
      assignee: issue.assignee ? { login: issue.assignee.login } : undefined,
      created_at: issue.created_at,
    }));
}

export async function fetchGitHubIssue(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubIssue | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "OpenUI-Desktop",
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const issue: any = await res.json();

  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    labels: issue.labels.map((l: any) => ({ name: l.name, color: l.color })),
    assignee: issue.assignee ? { login: issue.assignee.login } : undefined,
    created_at: issue.created_at,
  };
}

export async function searchGitHubIssues(
  owner: string,
  repo: string,
  query: string
): Promise<GitHubIssue[]> {
  const searchQuery = `${query} repo:${owner}/${repo} is:issue`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=20`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "OpenUI-Desktop",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const data: any = await res.json();

  return data.items.map((issue: any) => ({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    labels: issue.labels.map((l: any) => ({ name: l.name, color: l.color })),
    assignee: issue.assignee ? { login: issue.assignee.login } : undefined,
    created_at: issue.created_at,
  }));
}
