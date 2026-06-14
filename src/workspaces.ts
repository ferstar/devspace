import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
  alreadyLoaded: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  loadedAgentsFiles: Map<string, string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly config: ServerConfig) {}

  async openWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      root,
      loadedAgentsFiles: new Map(),
    };

    this.workspaces.set(workspace.id, workspace);
    const agentsFiles = await this.loadAgentsForDirectory(workspace, root);

    return { workspace, agentsFiles };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }

    return workspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  async loadAgentsForPath(workspace: Workspace, absolutePath: string): Promise<LoadedAgentsFile[]> {
    const directory = await this.pathDirectory(absolutePath);
    return this.loadAgentsForDirectory(workspace, directory);
  }

  async loadAgentsForDirectory(workspace: Workspace, directory: string): Promise<LoadedAgentsFile[]> {
    const resolvedDirectory = assertAllowedPath(directory, [workspace.root]);
    const directories = directoriesBetween(workspace.root, resolvedDirectory);
    const loaded: LoadedAgentsFile[] = [];

    for (const currentDirectory of directories) {
      const agentsPath = join(currentDirectory, "AGENTS.md");
      const content = await readOptionalTextFile(agentsPath);
      if (content === undefined) continue;

      const existingContent = workspace.loadedAgentsFiles.get(agentsPath);
      const alreadyLoaded = existingContent === content;
      if (!alreadyLoaded) {
        workspace.loadedAgentsFiles.set(agentsPath, content);
      }

      loaded.push({ path: agentsPath, content, alreadyLoaded });
    }

    return loaded;
  }

  private async pathDirectory(absolutePath: string): Promise<string> {
    try {
      const pathStats = await stat(absolutePath);
      return pathStats.isDirectory() ? absolutePath : dirname(absolutePath);
    } catch {
      return dirname(absolutePath);
    }
  }
}

async function readOptionalTextFile(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

function directoriesBetween(root: string, directory: string): string[] {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(directory);
  const relationship = relative(resolvedRoot, resolvedDirectory);

  if (relationship === "") return [resolvedRoot];
  if (relationship.startsWith("..") || relationship === ".." || relationship.includes(`..${sep}`)) {
    throw new Error(`Directory is outside workspace root: ${directory}`);
  }

  const parts = relationship.split(sep).filter(Boolean);
  const directories = [resolvedRoot];
  let current = resolvedRoot;
  for (const part of parts) {
    current = join(current, part);
    directories.push(current);
  }

  return directories;
}

export function formatAgentsNotice(agentsFiles: LoadedAgentsFile[]): string | undefined {
  if (agentsFiles.length === 0) return undefined;

  const sections = agentsFiles.map((file) => {
    const status = file.alreadyLoaded ? "already loaded" : "newly loaded";
    return `## ${file.path} (${status})\n\n${file.content}`;
  });

  return `AGENTS.md context for this workspace path:\n\n${sections.join("\n\n")}`;
}
