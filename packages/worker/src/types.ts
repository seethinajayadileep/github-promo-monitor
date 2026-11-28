export interface CommitSearchItem {
  sha: string;
  html_url: string;
  repository?: { full_name?: string };
  commit?: {
    message?: string;
    committer?: { date?: string };
    author?: { date?: string };
  };
}

export interface IssueSearchItem {
  html_url: string;
  title?: string;
  body?: string;
  created_at?: string;
  repository_url?: string;
}

export interface CodeSearchItem {
  html_url: string;
  path: string;
  sha?: string;
  repository?: { full_name?: string };
  text_matches?: Array<{ fragment?: string }>;
}

export interface SearchResponse<T> {
  total_count: number;
  incomplete_results?: boolean;
  items: T[];
}

export interface RepoCommitListItem {
  sha: string;
  html_url: string;
  commit?: {
    message?: string;
    committer?: { date?: string };
  };
}

export interface CommitDetail {
  sha: string;
  html_url: string;
  commit?: {
    message?: string;
    committer?: { date?: string };
  };
  files?: Array<{ filename?: string; patch?: string; status?: string }>;
}
