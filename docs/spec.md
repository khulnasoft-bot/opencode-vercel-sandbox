# OpenCode Sandbox plugin specification

## Problem and outcome

OpenCode users need to run agent commands away from their laptop. The package offers automatic remote tools and an explicit remote workspace adapter. The sections below first describe workspace mode; automatic mode has a separate section at the end.

## Reference and design choice

Daytona's plugin replaces file and shell tools, keeps a sandbox per session, generates preview links and synchronizes remote changes to local Git branches. Its implementation is the functional reference, not copied source.

Workspace mode uses OpenCode's native remote-workspace adapter. OpenCode itself runs in the VM, so this mode does not maintain separate implementations of read, edit, search, shell or permission handling. The tradeoff is reliance on an experimental host API and explicit export rather than automatic per-turn sync.

| Capability | Workspace mode |
| --- | --- |
| Plugin format | Default object with `server`, plus `./server` package export |
| Isolation | One persistent Vercel Sandbox per OpenCode workspace |
| Source | Git bundle of committed HEAD, including history |
| Tools | Native OpenCode tools running in the VM |
| Local return | Explicit export to a new branch; no local checkout or index mutation |
| Reconnect | Same named Sandbox, authenticated server health check |
| Stop/resume | Persistent files; restart the OpenCode server |
| Removal | Stop only; retained filesystem can still be exported |
| Preview | Configured additional ports; no automatic server detection |
| Credentials | Sandbox auth stays local; one Gateway API key is brokered by the firewall, with a non-secret placeholder in the VM |

## Boundaries

The host calls the Sandbox SDK. The adapter uploads a Git bundle, launches a version-pinned OpenCode server and returns an HTTPS target with a Basic authorization header. Host workspace metadata contains only the Sandbox name. A local private key file holds the server password. OpenCode's native host code owns session routing and history synchronization.

OpenCode's native global installer registers the package once. With the experimental workspace flag enabled, users start the normal CLI and select Vercel Sandbox from `/warp`. Merely loading the plugin does not create a VM. Project-level configuration is optional.

Explicit OIDC or complete access-token environment settings take precedence. Otherwise, the plugin reads the existing Vercel CLI login through the pinned Sandbox SDK's exported auth interface. Expired logins refresh using the official CLI, scoped to the explicitly selected team. It requires either a configured team/project pair or a `.vercel/project.json` at the repository root; it never infers or creates a billing project. Login and linking failures give terminal setup instructions instead of prompting inside OpenCode.

Sandbox names derive from both project ID and workspace ID. The adapter does not trust a supplied `extra.sandboxName` to select a resource. Connection failures do not create replacement sandboxes. The source branch, host index and host working tree remain unchanged.

## Lifecycle

1. Configure the workspace with its derived Sandbox name and remote directory.
2. Capture committed source and verify local HEAD has not moved during capture.
3. Resolve a host Gateway API key and explicit Gateway model; create a persistent Sandbox with its firewall policy, bounded session and private server password.
4. Upload source, clone into the remote directory, install the pinned server and await health.
5. Validate the local broker record and billing/model scope, reload the host key, update the policy without resuming, then resume and resolve the authenticated remote target.
6. Export the current Git tree into a unique local branch when requested.
7. Stop on workspace removal; retain the sandbox and latest snapshot.

Creation errors retain the Sandbox and command logs for investigation. Removing the OpenCode workspace does not delete Vercel storage. Old pre-brokering workspaces are refused and can still contain copied model credentials in retained files or snapshots; the upgrade does not scrub them. New workspaces never receive provider keys from inherited auth, forwarded environment variables, or arbitrary provider configuration. They still contain a separate server password and committed source history.

The broker authenticates the configured model's POST inference request at the fixed Gateway endpoint, with a pinned Host header. Other networking remains available without injected credentials. This boundary protects provider keys, not budgets or data sent in authorized model requests. OAuth and subscription authentication are outside this version. Policy failures do not return a workspace connection. A host-side activation lock prevents concurrent initialization and reconnect operations.

## Acceptance

- Load the package through the real OpenCode plugin loader and list the adapter.
- Create a workspace through the real host API and observe a remote agent edit.
- Reject an unauthenticated request to the remote server.
- Export tracked, untracked, deleted and binary files while preserving local changes and the index.
- Stop, reconnect, restart the server and verify the edited file persists.
- Fail closed on missing credentials, invalid options and failed command exit status.
- Verify synthetic keys never enter VM inputs, state, connection metadata or errors, and policy refresh precedes resume.
- Verify real Gateway streaming and tool calls with placeholder-only remote authentication, including stop/reconnect and legacy-workspace refusal.
- Typecheck, build, package and independently review the final source.
- Install globally and create a workspace through the real terminal `/warp` picker, with no project plugin configuration or exported control-plane token.
- Preserve existing global settings; test reconnect through normal `opencode --session`, and export/stop using the saved login and linked repository.

## Compatibility and publication

Pinned API: OpenCode 1.18.32 and Sandbox SDK 3.5.0. The current published OpenCode version numbering remains 1.x; do not describe this as tested against a 2.x CLI. The `2.0` source branch has a different `create` signature.

Before publication, choose the Vercel-owned package and repository names, verify the package installation path and rendered README, and submit an ecosystem entry linking the published repository. A local build is not an official ecosystem listing.
## Automatic tool mode

Opt-in `mode: "automatic"` keeps the local OpenCode model loop and provider authentication on the host. A session manager resolves explicit Vercel scope, captures committed Git history, persists an initializing record, creates one named persistent VM, initializes its project, then permits supported remote tool calls. The existing workspace adapter is unchanged and remains the default. No remote OpenCode server is needed for automatic mode.

State is keyed by Vercel team/project scope, OpenCode project, canonical worktree and session ID, stored under OpenCode's XDG data directory with private atomic files. OIDC scope uses the SDK's owner_id/project_id claims; token rotation does not change identity. Each operation holds a per-session cross-process lock; tools and sync also queue in-process. Incomplete initialization and stale locks fail closed for inspection. Neither error triggers a new allocation or reset. The state contains no credentials. Permissions and cancellation are checked before allocation and propagated through setup, tools and sync.

Idle handling requests serialized Git return. Explicit gitSync awaits it. Snapshot commits return through validated Git bundles to a stable separate branch, with expected-old-ref updates and refusal to modify checked-out or externally changed return branches. Local checkout/index/HEAD stay unchanged. Sync errors persist; disposal drains for at most 60 seconds and reports failure. sandboxStop returns pending files before stopping and prevents idle/disposal from resuming the stopped VM. No automatic deletion occurs.

Shell/file operations execute only through the SDK inside the VM. Additional user plugins are rejected; MCP/LSP/subagent/skill/code-mode paths are disabled. apply_patch has an explicit unsupported implementation with remote bash as the alternative. A tool hook blocks unknown agent tools; shell.env blocks direct host shell. This is not isolation of host configuration, attachments, custom command templates, Git metadata or the OpenCode process itself. Background mutation, arbitrary extra integrations and OpenCode v2 are outside scope.

Supported tools also include `sandboxStatus`, which reports the running Sandbox's configuration and usage without starting or stopping compute, and `sandboxExtend`, which lengthens the session timeout before expiry and refuses non-running Sandboxes. Both require permission and reuse the session's allocation; neither mutates files.
