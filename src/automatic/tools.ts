import { randomUUID } from "node:crypto";
import { posix, relative, isAbsolute } from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import { WORKSPACE } from "../config.js";
import type { Sessions } from "./session.js";
import { fileWorker, type FileRequest } from "./worker.js";

export function remotePath(value: string, worktree: string) {
  let translated = value;
  if (value === worktree || value.startsWith(`${worktree}/`)) translated = posix.join(WORKSPACE, relative(worktree, value));
  else if (!isAbsolute(value)) translated = posix.resolve(WORKSPACE, value);
  translated = posix.normalize(translated);
  if (!["/vercel/sandbox", "/tmp"].some((root) => translated === root || translated.startsWith(`${root}/`))) throw new Error("Path is outside the sandbox workspace or /tmp. Laptop paths outside this project cannot be accessed.");
  if (translated.includes("\0")) throw new Error("Invalid path");
  return translated;
}

export async function executeRemote(sandbox: Sandbox, cmd: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs = 120_000) {
  signal.throwIfAborted();
  const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 10_000)]);
  const command = await sandbox.runCommand({ cmd: "timeout", args: ["--signal=KILL", `${Math.ceil(timeoutMs / 1000)}s`, cmd, ...args], cwd, detached: true, signal: abort });
  let output = "";
  let truncated = false;
  try {
    for await (const log of command.logs({ signal: abort })) {
      const remaining = 64_000 - output.length;
      if (log.data.length > remaining) truncated = true;
      if (remaining > 0) output += log.data.slice(0, remaining);
    }
    const finished = await command.wait({ signal: abort });
    return `Exit code: ${finished.exitCode}\n${output}${truncated ? "\n[output truncated]" : ""}`;
  } catch (error) {
    await command.kill("SIGTERM", { abortSignal: AbortSignal.timeout(10_000) }).catch(() => {});
    throw error;
  }
}

export function createTools(sessions: Sessions): Record<string, ToolDefinition> {
  const schema = tool.schema;
  const filePath = schema.string().min(1).max(4096);
  const text = schema.string().max(1024 * 1024);
  const edit = schema.object({ oldString: text.min(1), newString: text, replaceAll: schema.boolean().optional() });
  const permission = async (context: ToolContext, name: string, pattern: string) => {
    context.abort.throwIfAborted();
    await context.ask({ permission: name, patterns: [pattern], always: [pattern], metadata: { sandbox: true } });
    context.abort.throwIfAborted();
  };
  const file = async (request: FileRequest, context: ToolContext) => {
    const translated = remotePath(request.path, sessions.worktree);
    await permission(context, ["write", "edit"].includes(request.operation) ? "edit" : request.operation === "ls" ? "read" : request.operation, request.path);
    return sessions.run(context.sessionID, async (sandbox) => {
      const worker = `/tmp/opencode-file-${randomUUID()}.js`;
      const source = `(${fileWorker.toString()})(${JSON.stringify({ ...request, path: translated })}).then(output => console.log(output)).catch(error => { console.error(error.message); process.exitCode = 1; });`;
      await sandbox.writeFiles([{ path: worker, content: Buffer.from(source) }], { signal: context.abort });
      try { return await executeRemote(sandbox, "node", [worker], WORKSPACE, context.abort); }
      finally { await sandbox.runCommand({ cmd: "rm", args: ["-f", worker], signal: AbortSignal.timeout(10_000) }).catch(() => {}); }
    }, context.abort);
  };
  return {
    bash: tool({
      description: "Run a shell command in Vercel Sandbox, never on the laptop. Supports scripts, tests and patches. Stop background file writers before syncing; they are not tracked.",
      args: { command: text, description: schema.string().optional(), workdir: filePath.optional(), timeout: schema.number().int().min(1000).max(120_000).optional() },
      async execute(args, context) {
        const cwd = remotePath(args.workdir ?? WORKSPACE, sessions.worktree);
        await permission(context, "bash", args.command);
        return sessions.run(context.sessionID, (sandbox) => executeRemote(sandbox, "bash", ["-c", args.command], cwd, context.abort, args.timeout), context.abort);
      },
    }),
    read: tool({ description: "Read a text file in Vercel Sandbox.", args: { filePath, offset: schema.number().int().min(1).optional(), limit: schema.number().int().min(1).max(2000).optional() }, execute: (args, context) => file({ operation: "read", path: args.filePath, offset: args.offset, limit: args.limit }, context) }),
    write: tool({ description: "Write a file in Vercel Sandbox.", args: { filePath, content: text }, execute: (args, context) => file({ operation: "write", path: args.filePath, content: args.content }, context) }),
    edit: tool({ description: "Replace exact text in a Vercel Sandbox file.", args: { filePath, oldString: text.min(1), newString: text, replaceAll: schema.boolean().optional() }, execute: (args, context) => file({ operation: "edit", path: args.filePath, edits: [args] }, context) }),
    multiedit: tool({ description: "Apply a series of exact text replacements to one Vercel Sandbox file.", args: { filePath, edits: schema.array(edit).min(1).max(100) }, execute: (args, context) => file({ operation: "edit", path: args.filePath, edits: args.edits }, context) }),
    ls: tool({ description: "List a directory in Vercel Sandbox.", args: { path: filePath.optional() }, execute: (args, context) => file({ operation: "ls", path: args.path ?? WORKSPACE }, context) }),
    glob: tool({ description: "Find files in Vercel Sandbox using a glob pattern.", args: { pattern: schema.string().max(1024), path: filePath.optional() }, execute: (args, context) => file({ operation: "glob", path: args.path ?? WORKSPACE, pattern: args.pattern }, context) }),
    grep: tool({ description: "Search text in Vercel Sandbox using ripgrep.", args: { pattern: schema.string().max(1024), path: filePath.optional(), include: schema.string().max(1024).optional() }, execute: (args, context) => file({ operation: "grep", path: args.path ?? WORKSPACE, pattern: args.pattern, include: args.include }, context) }),
    apply_patch: tool({ description: "Unavailable in automatic mode. Use the sandbox bash tool with a script to edit files instead; never use a local patch command.", args: { patchText: text }, async execute() { throw new Error("apply_patch is disabled in automatic mode. Use remote bash to edit files."); } }),
    gitSync: tool({ description: "Wait for changes to return to the session's separate local Git branch. Does not change your checkout.", args: {}, async execute(_args, context) { await permission(context, "gitSync", sessions.worktree); return sessions.sync(context.sessionID, false, context.abort); } }),
    sandboxStop: tool({ description: "Sync this session, then stop its Sandbox and retain files for later resume. Refuses to stop if sync fails.", args: {}, async execute(_args, context) { await permission(context, "sandboxStop", sessions.worktree); return sessions.sync(context.sessionID, true, context.abort); } }),
    getPreviewURL: tool({ description: "Get the public URL for an explicitly configured Sandbox preview port. Servers must bind to 0.0.0.0.", args: { port: schema.number().int() }, async execute(args, context) {
      if (!sessions.options.previewPorts.includes(args.port)) throw new Error("Port not configured in previewPorts; no new port will be exposed.");
      await permission(context, "getPreviewURL", String(args.port));
      return sessions.run(context.sessionID, async (sandbox) => sandbox.domain(args.port), context.abort);
    } }),
    sandboxStatus: tool({ description: "Report the current Vercel Sandbox status, configuration and usage for this session. Does not start or stop compute.", args: {}, async execute(_args, context) {
      await permission(context, "sandboxStatus", sessions.worktree);
      return sessions.run(context.sessionID, async (sandbox) => JSON.stringify({
        name: sandbox.name,
        status: sandbox.status,
        region: sandbox.region,
        failoverRegions: sandbox.failoverRegions,
        vcpus: sandbox.vcpus,
        memory: sandbox.memory,
        image: sandbox.image,
        persistent: sandbox.persistent,
        timeout: sandbox.timeout,
        expiresAt: sandbox.expiresAt?.toISOString() ?? null,
        createdAt: sandbox.createdAt.toISOString(),
        updatedAt: sandbox.updatedAt.toISOString(),
        statusUpdatedAt: sandbox.statusUpdatedAt?.toISOString() ?? null,
        cwd: sandbox.cwd,
        tags: sandbox.tags ?? {},
        networkPolicy: sandbox.networkPolicy ?? null,
        currentSnapshotId: sandbox.currentSnapshotId ?? null,
        totalActiveCpuDurationMs: sandbox.totalActiveCpuDurationMs,
        totalDurationMs: sandbox.totalDurationMs,
        totalEgressBytes: sandbox.totalEgressBytes,
        totalIngressBytes: sandbox.totalIngressBytes,
        activeCpuUsageMs: sandbox.activeCpuUsageMs,
        networkTransfer: sandbox.networkTransfer,
      }, null, 2), context.abort);
    } }),
    sandboxExtend: tool({ description: "Extend this session's Vercel Sandbox timeout before it expires. Refused once the Sandbox is stopping or stopped.", args: { duration: schema.number().int().min(60_000).max(900_000) }, async execute(args, context) {
      if (!Number.isInteger(args.duration) || args.duration < 60_000 || args.duration > 900_000) throw new Error("Duration must be an integer between 60,000 and 900,000 milliseconds.");
      await permission(context, "sandboxExtend", sessions.worktree);
      return sessions.run(context.sessionID, async (sandbox) => {
        if (sandbox.status !== "running") throw new Error(`Cannot extend a Sandbox that is ${sandbox.status}. Wait for it to become running or stop it.`);
        await sandbox.extendTimeout(args.duration);
        return `Extended ${sandbox.name} by ${args.duration}ms; expires at ${sandbox.expiresAt?.toISOString() ?? "unknown"}`;
      }, context.abort);
    } }),
  };
}
