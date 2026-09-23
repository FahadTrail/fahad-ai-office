# Development escape route

This is an isolated, approval-gated controller for future development jobs. It uses pinned OpenCode with the DeepSeek canary, while the controller—not the model—owns testing, Git commits, GitHub publication, and PR creation.

Security boundaries:

- OpenCode receives a dedicated home and an external key file; the provider key is not present in tool-process environment variables.
- The coding model may read and edit only its task worktree. Shell, web, subagents, questions, external paths, and secret files are denied.
- GitHub credentials never enter the OpenCode process.
- The controller blocks deployment files, workflows, migrations, Hermes paths, credentials, and local OpenCode overrides.
- The controller runs tests after each model pass and returns only redacted failures for autonomous repair.
- Merge and production deployment remain outside this controller and require the existing policy approval.

The CLI accepts only a controller-owned JSON file so objectives are not interpolated into a shell command. Production activation is intentionally deferred until a DeepSeek credential and billing authorization are provided and the live canary passes.
