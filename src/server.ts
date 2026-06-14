import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { formatAgentsNotice, WorkspaceRegistry } from "./workspaces.js";

type Transport = StreamableHTTPServerTransport;

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
}

function isAuthorized(req: Request, config: ServerConfig): boolean {
  if (!config.authToken) return true;

  const authorization = req.header("authorization");
  return authorization === `Bearer ${config.authToken}`;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function createMcpServer(config: ServerConfig): McpServer {
  const workspaces = new WorkspaceRegistry(config);
  const server = new McpServer({
    name: "local-coding-workspace",
    version: "0.1.0",
  });

  server.registerTool(
    "server_info",
    {
      title: "Server info",
      description: "Return basic information about this local pi-on-mcp server.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: "pi-on-mcp",
              mcpName: "local-coding-workspace",
              allowedRoots: config.allowedRoots,
              mutationToolsEnabled: true,
              workflow:
                "Call open_workspace first, then use the returned workspaceId for read, edit, search, list, and shell tools.",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this before reading, editing, searching, or running commands. The result includes any AGENTS.md instructions discovered at the workspace root.",
      inputSchema: {
        path: z.string().describe("Absolute path to a local project directory inside an allowed root."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const { workspace, agentsFiles } = await workspaces.openWorkspace(path);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workspaceId: workspace.id,
                root: workspace.root,
                loadedAgentsFiles: agentsFiles.map((file) => ({
                  path: file.path,
                  alreadyLoaded: file.alreadyLoaded,
                })),
                instruction:
                  "Use this workspaceId in all subsequent tool calls for this project. Follow the AGENTS.md context returned below.",
              },
              null,
              2,
            ),
          },
          ...(formatAgentsNotice(agentsFiles) ? [{ type: "text" as const, text: formatAgentsNotice(agentsFiles)! }] : []),
        ],
      };
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file inside an open workspace. Call open_workspace first, then pass workspaceId. If the file path enters a directory with an AGENTS.md that has not been loaded yet, that AGENTS.md is returned with the tool result.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("File path to read, relative to the workspace root."),
        offset: z.number().int().positive().optional().describe("1-indexed line number to start reading from."),
        limit: z.number().int().positive().optional().describe("Maximum number of lines to read."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(await workspaces.loadAgentsForPath(workspace, targetPath));
      return readFileTool(input, { cwd: workspace.root, root: workspace.root, agentsNotice });
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Write a complete file inside an open workspace. Prefer edit_file for targeted changes. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(await workspaces.loadAgentsForPath(workspace, targetPath));
      return writeFileTool(input, { cwd: workspace.root, root: workspace.root, agentsNotice });
    },
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description:
        "Edit one file inside an open workspace by replacing exact text blocks. Prefer this over write_file for small changes. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe("Exact text to replace. Must match uniquely in the original file."),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      annotations: { destructiveHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(await workspaces.loadAgentsForPath(workspace, targetPath));
      return editFileTool(input, { cwd: workspace.root, root: workspace.root, agentsNotice });
    },
  );

  server.registerTool(
    "grep_files",
    {
      title: "Grep files",
      description:
        "Search file contents inside an open workspace. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("Search pattern."),
        path: z.string().optional().describe("Optional path or glob scope relative to the workspace root."),
        include: z.string().optional().describe("Optional include glob."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = input.path ? workspaces.resolvePath(workspace, input.path) : workspace.root;
      const agentsNotice = formatAgentsNotice(await workspaces.loadAgentsForPath(workspace, targetPath));
      return grepFilesTool(input, { cwd: workspace.root, root: workspace.root, agentsNotice });
    },
  );

  server.registerTool(
    "find_files",
    {
      title: "Find files",
      description: "Find files by glob pattern inside an open workspace. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        pattern: z.string().describe("File glob pattern."),
        path: z.string().optional().describe("Optional path scope relative to the workspace root."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = input.path ? workspaces.resolvePath(workspace, input.path) : workspace.root;
      const agentsNotice = formatAgentsNotice(await workspaces.loadAgentsForPath(workspace, targetPath));
      return findFilesTool(input, { cwd: workspace.root, root: workspace.root, agentsNotice });
    },
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List a directory inside an open workspace. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        path: z.string().describe("Directory path to list, relative to the workspace root."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const agentsNotice = formatAgentsNotice(await workspaces.loadAgentsForPath(workspace, targetPath));
      return listDirectoryTool(input, { cwd: workspace.root, root: workspace.root, agentsNotice });
    },
  );

  server.registerTool(
    "run_shell",
    {
      title: "Run shell",
      description:
        "Run a shell command inside an open workspace. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        command: z.string().describe("Shell command to run."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Optional working directory relative to the workspace root. Defaults to the workspace root."),
        timeout: z.number().positive().max(300).optional().describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const agentsNotice = formatAgentsNotice(await workspaces.loadAgentsForDirectory(workspace, cwd));
      return runShellTool(input, { cwd, root: workspace.root, agentsNotice });
    },
  );

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: [config.host, "localhost", "127.0.0.1"],
  });
  const transports = new Map<string, Transport>();

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "pi-on-mcp" });
  });

  app.all("/mcp", async (req, res) => {
    if (!isAuthorized(req, config)) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    try {
      const sessionId = req.header("mcp-session-id");
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };

        const server = createMcpServer(config);
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  return { app, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, config } = createServer();
  app.listen(config.port, config.host, () => {
    console.log(`pi-on-mcp listening on http://${config.host}:${config.port}/mcp`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(config.authToken ? "auth: bearer token required" : "auth: disabled");
  });
}
