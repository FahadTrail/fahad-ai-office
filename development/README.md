# Development escape route

This is an isolated, approval-gated controller for future development jobs. It uses pinned OpenCode with an automatically selected, privacy-authorized external coding provider, while the controller—not the model—owns testing, Git commits, GitHub publication, and PR creation.

Security boundaries:

- OpenCode receives a dedicated home and an external key file; the provider key is not present in tool-process environment variables.
- Private repository execution fails closed unless the selected provider has a server-side key, an independently reviewed API data policy, and its server-side authorization flag. DeepSeek keeps `DEEPSEEK_API_TRAINING_OPTOUT_VERIFIED`; Qwen, Kimi, Zhipu and MiniMax use provider-specific `*_API_PRIVATE_DATA_APPROVED` flags. These flags are not credentials and are never forwarded to the model.
- The controller is the only root process inside its isolated container. It immediately runs OpenCode as the unprivileged `node` identity and generated tests as the separate `nobody` identity; neither child can inherit the controller's credentials.
- The coding model may read and edit only its task worktree. Shell, web, subagents, questions, external paths, and secret files are denied.
- GitHub credentials never enter the OpenCode process.
- The controller blocks deployment files, workflows, migrations, Hermes paths, credentials, and local OpenCode overrides.
- The controller runs tests after each model pass and returns only redacted failures for autonomous repair.
- Every successful model pass must include machine-readable token and cost accounting. The controller applies the selected model's conservative rates and stops before publication above `DEVELOPMENT_MAX_COST_USD` (USD 2 by default).
- The provider route is computed from configured credentials, privacy approval, coding quality and cost. A provider execution failure moves automatically to the next eligible provider while preserving the isolated worktree; no user model switch is needed.
- Merge and production deployment remain outside this controller and require the existing policy approval.

The CLI accepts only a controller-owned JSON file so objectives are not interpolated into a shell command. New providers remain unavailable until their credentials, billing, privacy authorization and isolated live canaries are complete.
