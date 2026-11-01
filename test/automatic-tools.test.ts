import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext } from "@opencode-ai/plugin";
import type { Sandbox } from "@vercel/sandbox";
import { createTools, executeRemote, remotePath } from "../src/automatic/tools.js";
import type { Sessions } from "../src/automatic/session.js";
import { fileWorker } from "../src/automatic/worker.js";

test("host-project paths map remotely; unrelated host paths and traversal rejected", () => {
  assert.equal(remotePath("/Users/fixture/project/src/a", "/Users/fixture/project"), "/vercel/sandbox/project/src/a");
  assert.equal(remotePath("src/a", "/Users/fixture/project"), "/vercel/sandbox/project/src/a");
  assert.equal(remotePath("/tmp/test", "/Users/fixture/project"), "/tmp/test");
  for (const value of ["/Users/private/key", "/etc/passwd", "../../../outside", "/tmp/../etc/file", "\0"]) assert.throws(() => remotePath(value, "/Users/fixture/project"));
});

test("permission denial and cancellation happen before sandbox allocation", async () => {
  let allocations = 0;
  const sessions = { worktree: "/tmp/project", options: { previewPorts: [] }, run: async () => { allocations++; }, sync: async () => { allocations++; } } as unknown as Sessions;
  const tools = createTools(sessions);
  const context = { sessionID: "one", abort: new AbortController().signal, ask: async () => { throw new Error("permission denied"); } } as unknown as ToolContext;
  await assert.rejects(tools.bash.execute({ command: "echo hello" }, context), /permission denied/);
  await assert.rejects(tools.write.execute({ filePath: "a", content: "test" }, context), /permission denied/);
  await assert.rejects(tools.gitSync.execute({}, context), /permission denied/);
  await assert.rejects(tools.getPreviewURL.execute({ port: 3000 }, context), /not configured/);
  await assert.rejects(tools.apply_patch.execute({ patchText: "test" }, context), /disabled/);
  await assert.rejects(tools.bash.execute({ command: "echo hello" }, { ...context, abort: AbortSignal.abort(), ask: async () => {} }), /abort/i);
  assert.equal(allocations, 0);
});

test("remote execution caps output and preserves exit status", async () => {
  const sandbox = { runCommand: async (options: { cmd: string; args: string[]; detached: boolean }) => {
    assert.equal(options.cmd, "timeout");
    assert.equal(options.detached, true);
    return { async *logs() { yield { data: "x".repeat(70_000) }; }, wait: async () => ({ exitCode: 7 }) };
  } } as unknown as Sandbox;
  const output = await executeRemote(sandbox, "bash", ["-c", "false"], "/vercel/sandbox/project", new AbortController().signal);
  assert.match(output, /Exit code: 7/);
  assert.match(output, /output truncated/);
  assert.ok(output.length < 65_000);
});

test("remote cancellation sends a termination signal", async () => {
  let killed = false;
  const sandbox = { runCommand: async () => ({ async *logs() { throw new Error("cancelled"); }, kill: async (signal: string) => { assert.equal(signal, "SIGTERM"); killed = true; } }) } as unknown as Sandbox;
  await assert.rejects(executeRemote(sandbox, "bash", ["-c", "sleep 100"], "/vercel/sandbox/project", new AbortController().signal), /cancelled/);
  assert.equal(killed, true);
});

test("sandboxStatus reports sandbox metadata without starting compute", async () => {
  const now = new Date("2026-11-01T00:00:00.000Z");
  const sandbox = {
    name: "oc-abc123",
    status: "running",
    region: "iad1",
    failoverRegions: ["sfo1"],
    vcpus: 2,
    memory: 4096,
    image: "vercel/sandbox/universal",
    persistent: true,
    timeout: 1_800_000,
    expiresAt: new Date("2026-11-01T00:30:00.000Z"),
    createdAt: now,
    updatedAt: now,
    statusUpdatedAt: now,
    cwd: "/vercel/sandbox/project",
    tags: { env: "test" },
    networkPolicy: { allow: { "*": [] } },
    currentSnapshotId: "snap-1",
    totalActiveCpuDurationMs: 100,
    totalDurationMs: 1000,
    totalEgressBytes: 50,
    totalIngressBytes: 10,
    activeCpuUsageMs: 25,
    networkTransfer: { ingress: 10, egress: 50 },
    domain: () => "https://preview.vercel.run",
  } as unknown as Sandbox;
  const sessions = { worktree: "/tmp/project", options: { previewPorts: [] }, run: async (_id: string, action: (sandbox: Sandbox) => Promise<string>) => action(sandbox) } as unknown as Sessions;
  const tools = createTools(sessions);
  const context = { sessionID: "one", abort: new AbortController().signal, ask: async () => {} } as unknown as ToolContext;
  const output = await tools.sandboxStatus.execute({}, context);
  const parsed = JSON.parse(output);
  assert.equal(parsed.name, "oc-abc123");
  assert.equal(parsed.status, "running");
  assert.equal(parsed.region, "iad1");
  assert.deepEqual(parsed.failoverRegions, ["sfo1"]);
  assert.equal(parsed.vcpus, 2);
  assert.equal(parsed.memory, 4096);
  assert.equal(parsed.image, "vercel/sandbox/universal");
  assert.equal(parsed.persistent, true);
  assert.equal(parsed.timeout, 1_800_000);
  assert.equal(parsed.expiresAt, "2026-11-01T00:30:00.000Z");
  assert.equal(parsed.createdAt, "2026-11-01T00:00:00.000Z");
  assert.equal(parsed.cwd, "/vercel/sandbox/project");
  assert.deepEqual(parsed.tags, { env: "test" });
  assert.equal(parsed.currentSnapshotId, "snap-1");
  assert.equal(parsed.totalActiveCpuDurationMs, 100);
  assert.equal(parsed.networkTransfer.egress, 50);
});

test("sandboxStatus permission denial happens before allocation", async () => {
  const sessions = { worktree: "/tmp/project", options: { previewPorts: [] }, run: async () => { throw new Error("should not allocate"); } } as unknown as Sessions;
  const tools = createTools(sessions);
  const context = { sessionID: "one", abort: new AbortController().signal, ask: async () => { throw new Error("permission denied"); } } as unknown as ToolContext;
  await assert.rejects(tools.sandboxStatus.execute({}, context), /permission denied/);
});

test("sandboxExtend lengthens a running sandbox and refuses non-running states", async () => {
  let extended = 0;
  let duration = 0;
  const sandbox = {
    name: "oc-extend",
    status: "running",
    expiresAt: new Date("2026-11-01T01:00:00.000Z"),
    extendTimeout: async (ms: number) => { extended++; duration = ms; },
  } as unknown as Sandbox;
  const sessions = { worktree: "/tmp/project", options: { previewPorts: [] }, run: async (_id: string, action: (sandbox: Sandbox) => Promise<string>) => action(sandbox) } as unknown as Sessions;
  const tools = createTools(sessions);
  const context = { sessionID: "one", abort: new AbortController().signal, ask: async () => {} } as unknown as ToolContext;
  const output = await tools.sandboxExtend.execute({ duration: 120_000 }, context);
  assert.equal(extended, 1);
  assert.equal(duration, 120_000);
  assert.match(output, /Extended oc-extend by 120000ms/);
  assert.match(output, /2026-11-01T01:00:00.000Z/);

  const stopped = { ...sandbox, status: "stopped", extendTimeout: async () => { throw new Error("should not extend"); } } as unknown as Sandbox;
  const stoppedSessions = { worktree: "/tmp/project", options: { previewPorts: [] }, run: async (_id: string, action: (sandbox: Sandbox) => Promise<string>) => action(stopped) } as unknown as Sessions;
  await assert.rejects(createTools(stoppedSessions).sandboxExtend.execute({ duration: 60_000 }, context), /stopped/);
});

test("sandboxExtend validates duration and denies permission before allocation", async () => {
  const sessions = { worktree: "/tmp/project", options: { previewPorts: [] }, run: async () => { throw new Error("should not allocate"); } } as unknown as Sessions;
  const tools = createTools(sessions);
  const context = { sessionID: "one", abort: new AbortController().signal, ask: async () => { throw new Error("permission denied"); } } as unknown as ToolContext;
  await assert.rejects(tools.sandboxExtend.execute({ duration: 1000 }, context), /duration/i);
  await assert.rejects(tools.sandboxExtend.execute({ duration: 1_000_000 }, context), /duration/i);
  await assert.rejects(tools.sandboxExtend.execute({ duration: 60_000 }, context), /permission denied/);
});

test("file worker reads, writes, applies exact edits and rejects ambiguous/binary edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-worker-test-"));
  const path = join(root, "file.txt");
  await fileWorker({ operation: "write", path, content: "first\nsecond\nsecond\n" });
  assert.match(await fileWorker({ operation: "read", path, offset: 2, limit: 1 }), /^2: second$/);
  await assert.rejects(fileWorker({ operation: "edit", path, edits: [{ oldString: "second", newString: "new" }] }), /ambiguous/);
  await fileWorker({ operation: "edit", path, edits: [{ oldString: "second", newString: "$&", replaceAll: true }] });
  assert.equal(await readFile(path, "utf8"), "first\n$&\n$&\n");
  await assert.rejects(fileWorker({ operation: "edit", path, edits: [{ oldString: "absent", newString: "new" }] }), /not found/);
  assert.match(await fileWorker({ operation: "ls", path: root }), /file.txt/);
  await writeFile(path, Buffer.from([0, 1, 2]));
  await assert.rejects(fileWorker({ operation: "read", path }), /Binary/);
});
