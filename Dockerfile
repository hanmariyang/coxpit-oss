# Coxpit daemon — self-hosted agent-fleet cockpit.
# node-pty has no linux prebuilds, so the build stage needs a compile toolchain.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY tsconfig.json ./

FROM node:22-bookworm-slim
# runtime tools the daemon spawns: git worktrees, tmux sessions, ssh to remote machines
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux openssh-client procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV COXPIT_HOST=0.0.0.0 \
    COXPIT_PORT=8210 \
    COXPIT_DB=/data/coxpit.db
VOLUME /data
EXPOSE 8210
# agent CLIs (claude etc.) are user concerns — mount or extend this image to add them.
CMD ["node", "--import", "tsx", "src/index.ts"]
