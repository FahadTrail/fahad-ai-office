FROM node:22-slim

# python3 + pip: the Coding Agent's Python project support (repository
# profile → `python3 -m pip install --user --break-system-packages`, `python3
# -m pytest`). Go and Rust toolchains are not installed; such sessions stop
# with TOOLCHAIN_MISSING (docs/FAHAD-OFFICE-V3-FINAL.md).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/workspace /app/logs /app/.claude \
 && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV CLAUDE_CONFIG_DIR=/app/.claude

HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=3 CMD ["node", "src/healthcheck.js", "--runtime"]

CMD ["node", "src/index.js"]
