FROM node:22-slim

ARG OPENCODE_VERSION=1.18.32

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && npm install --global --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
 && rm -rf /var/lib/apt/lists/* /root/.npm

WORKDIR /controller
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY development ./development

RUN mkdir -p /controller/isolation \
 && chown -R node:node /controller

USER node
ENV NODE_ENV=production
ENTRYPOINT ["node", "development/escape-route.js"]
