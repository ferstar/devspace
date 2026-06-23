import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitEligibility {
  ok: boolean;
  gitRoot?: string;
  reason?: "not_git" | "no_head";
  message?: string;
}

export async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });

  return { stdout, stderr };
}

export async function getGitEligibility(cwd: string): Promise<GitEligibility> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      ok: false,
      reason: "not_git",
      message: "workspace is not inside a git repository",
    };
  }

  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    return {
      ok: false,
      gitRoot,
      reason: "no_head",
      message: "repository has no HEAD commit",
    };
  }

  return { ok: true, gitRoot };
}

export function safeWorkspaceRefSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}

export interface GitStatusOptions {
  short?: boolean;
}

export async function gitStatus(
  cwd: string,
  options: GitStatusOptions = {},
): Promise<string> {
  const args = options.short ? ["status", "--short"] : ["status", "--porcelain", "-b"];
  const result = await git(cwd, args);
  return result.stdout;
}

export interface GitDiffOptions {
  staged?: boolean;
  from?: string;
  to?: string;
  path?: string;
}

export async function gitDiff(
  cwd: string,
  options: GitDiffOptions = {},
): Promise<string> {
  const args: string[] = ["diff", "--no-color"];
  if (options.staged) args.push("--staged");
  if (options.from) {
    args.push(options.to ? `${options.from}...${options.to}` : options.from);
  }
  if (options.path) args.push("--", options.path);
  const result = await git(cwd, args);
  return result.stdout;
}

export interface GitLogOptions {
  count?: number;
  path?: string;
  format?: string;
}

export async function gitLog(
  cwd: string,
  options: GitLogOptions = {},
): Promise<string> {
  const args: string[] = ["log", "--no-color"];
  if (options.format) {
    args.push(`--format=${options.format}`);
  } else {
    args.push("--oneline");
  }
  if (options.count && options.count > 0) {
    args.push(`-n${options.count}`);
  }
  if (options.path) args.push("--", options.path);
  const result = await git(cwd, args, { maxBuffer: 5 * 1024 * 1024 });
  return result.stdout;
}
