FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
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
