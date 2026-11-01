# Vercel Sandbox for OpenCode

Run OpenCode's supported shell and file tools in a Vercel Sandbox while keeping OpenCode and model authentication on your laptop. In automatic mode, the first tool call creates the Sandbox and edits return to a separate local Git branch.

**Unreleased preview.** This repository is under engineering review. Nothing is published to npm yet. Only **OpenCode 1.18.32** is tested; newer versions are not supported by this preview. Sandbox usage is billable.

## Choose a mode

| Mode | What runs in the Sandbox | How it starts |
| --- | --- | --- |
| Automatic tools | Supported agent shell and file tools | First supported tool call, with `mode: "automatic"` |
| [Remote workspace](docs/workspace.md) | OpenCode server, Gateway model access and agent tools | Configure a Gateway model, then select Vercel Sandbox with `/warp` |
| [Standalone terminal](docs/terminal.md) | The whole OpenCode session | Create and connect through Vercel CLI, without this plugin |

Both plugin modes are in this package. Use only one mode per OpenCode instance. Omitting `mode` selects the workspace behavior, not automatic mode.

Workspace mode brokers an AI Gateway API key through the Sandbox firewall instead of copying provider credentials into the VM. It requires a fresh workspace and a configured Gateway model. OAuth, subscription logins, and credential-forwarding options are not supported. Code can still make billable model requests. See the [workspace setup and migration notes](docs/workspace.md).

## Try automatic mode from source

Requires Node.js 22+, Git, Vercel CLI, a Vercel project with Sandbox access and your own OpenCode model setup. AI Gateway is optional. Use a disposable committed Git project and an OpenCode profile with no other user plugins.

Build this repository:

```sh
git clone https://github.com/vercel-labs/opencode-vercel-sandbox.git
cd opencode-vercel-sandbox
git switch add-opencode-plugin
npm ci
npm run check
npm run build
```

While this repository is private, cloning requires collaborator access. These commands select the implementation review branch; the default branch only contains the review notice.

In the Git project you want to work on, sign in and select the Vercel project that owns and pays for the Sandbox:

```sh
vercel login
vercel link
```

Keep `.vercel/` out of Git. Add the following to that project's `opencode.json`, preserving other settings. Replace the path with the absolute path to this repository's built `dist/index.js`. Keep this repository in place while using the plugin.

```json
{
  "plugin": [
    ["/absolute/path/to/opencode-vercel-sandbox/dist/index.js", { "mode": "automatic" }]
  ]
}
```

To opt in globally instead, put that entry in `~/.config/opencode/opencode.json` (under `$XDG_CONFIG_HOME` if set). OpenCode then loads it for projects you open, so use a dedicated profile and start from a Git project. You do not need to repeat installation in each project.

Start the pinned OpenCode version from the project:

```sh
export OPENCODE_DISABLE_AUTOUPDATE=true
npx --yes opencode-ai@1.18.32
```

Configure your model through OpenCode's normal provider setup, then ask it to create and test a file. A Vercel Sandbox notification confirms creation or reconnection. Model authentication remains local in automatic mode; the plugin does not select a model or provide model access.

## Review changes and stop

The initial upload contains **committed HEAD and Git history only**. Staged, unstaged and untracked local files are not uploaded. Review committed history for secrets before starting.

When the agent becomes idle, changes return to `vercel-sandbox/<session-key>`. Your current branch, files and staging area stay unchanged. Ask the agent to run `gitSync` to wait for return and show the exact branch, then inspect it with `git diff HEAD..<returned-branch>`. Git-ignored files are not returned. Do not check out or modify the return branch while the session is active; copy it to another branch for local work.

Ask the agent to run `sandboxStop` before exiting. It syncs pending changes, then stops compute without deleting the Sandbox. If sync fails, stopping is refused so remote files remain available for inspection. Retained storage remains billable. **Exiting OpenCode alone is not a stop command.** Resume the same OpenCode session to reuse its Sandbox; running processes are not restored.

Exit normally so pending sync can finish. Forced termination can leave a lock requiring inspection. Failed setup is preserved rather than automatically reset. Do not delete state files or diagnostic Sandboxes to recover without first inspecting them.

## Preview boundaries

- Supported tools: `bash`, `read`, `write`, `edit`, `multiedit`, `ls`, `glob`, `grep`, `gitSync`, `sandboxStop`, `getPreviewURL`, `sandboxStatus` and `sandboxExtend`. Previews require an explicit `previewPorts` entry and expose a public port.
- `apply_patch`, subagents, LSP, skills, code-mode, MCP and direct local shell are disabled. Use remote `bash` for editing when necessary. Additional user plugins are rejected.
- This isolates supported tools, not the local OpenCode application. Local configuration, explicit attachments, custom command templates and Git metadata are outside the isolation guarantee. Choose the standalone terminal for the whole OpenCode process inside the VM.
- Permission and cancellation checks apply. Shell calls are limited to two minutes and displayed output to 64,000 characters; Git bundles are capped at 64 MiB. Background file writers are not tracked. Stop them before syncing.
- Invalid options, starting outside Git or adding another user plugin blocks chat and tools until fixed. A missing or unloadable plugin cannot install those guards; verify the build, version and plugin status before use.

Automatic mode accepts `project`, `image`, `region`, `timeoutMs`, `vcpus` and `previewPorts`. Its defaults are the universal image, 30 minutes, 2 vCPUs and no preview ports. `project` can be an explicit `{ "teamId": "...", "projectId": "..." }` billing scope. `forwardEnv` and `remoteConfig` are rejected in this mode. Workspace mode has different defaults and credential behavior, documented in its [guide](docs/workspace.md).

## Development and release

See [contributing](CONTRIBUTING.md) for local checks and [the release checklist](docs/releasing.md) for review, npm publication, published-package E2E and ecosystem submissions. The current package has a private publication guard; license and publisher approval remain pending.
