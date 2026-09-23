# Development escape route

This is an isolated, approval-gated controller for future development jobs. It uses pinned OpenCode with the DeepSeek canary, while the controller—not the model—owns testing, Git commits, GitHub publication, and PR creation.

Security boundaries:

- OpenCode receives a dedicated home and an external key file; the provider key is not present in tool-process environment variables.
- Private repository execution fails closed unless the server-side authorization flag `DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED=true` records that DeepSeek's account-level training opt-out was verified. The flag is not a credential and is never forwarded to the model.
- The controller is the only root process inside its isolated container. It immediately runs OpenCode as the unprivileged `node` identity and generated tests as the separate `nobody` identity; neither child can inherit the controller's credentials.
- The coding model may read and edit only its task worktree. Shell, web, subagents, questions, external paths, and secret files are denied.
- GitHub credentials never enter the OpenCode process.
- The controller blocks deployment files, workflows, migrations, Hermes paths, credentials, and local OpenCode overrides.
- The controller runs tests after each model pass and returns only redacted failures for autonomous repair.
- Every successful model pass must include machine-readable token and cost accounting. The controller uses conservative DeepSeek peak rates and stops before publication above `DEVELOPMENT_MAX_COST_USD` (USD 2 by default).
- Merge and production deployment remain outside this controller and require the existing policy approval.

The CLI accepts only a controller-owned JSON file so objectives are not interpolated into a shell command. Production activation is intentionally deferred until a DeepSeek credential, billing authorization, and API training opt-out verification are provided and the live canary passes.
