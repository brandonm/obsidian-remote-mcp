# ABOUTME: Runtime image for obsidian-remote-mcp. Bun runs the TypeScript directly — there is no
# build step — so this only installs pinned production dependencies and copies src/.
#
# The vault is never copied in. It is a bind mount at run time, which keeps notes out of every
# layer and lets the image be published without carrying anything personal.

# Pinned to the same Bun the lockfile's packageManager field names, so the image matches what the
# test suite was verified against. Bump both together.
FROM oven/bun:1.3.11-slim AS deps

WORKDIR /app

# Dependency manifests first, so a source-only change reuses the install layer.
# bunfig.toml matters here: it carries frozenLockfile and the release-age gate, and an install
# that ignores it would silently resolve different versions than the ones reviewed.
COPY package.json bun.lock bunfig.toml ./

# --frozen-lockfile: install exactly the reviewed, integrity-pinned versions. Never relax this.
# --production: devDependencies (the MCP test client, type packages) are not needed to serve.
# --omit=optional: leaves out web-clipper-headless. That tool fetches arbitrary URLs from inside
#   the network with no SSRF protection, and registration is skipped silently when the package is
#   absent — so omitting it is the supported way to not expose it. Drop this flag only if you
#   actually clip pages and have accepted that trade-off.
RUN bun install --frozen-lockfile --production --omit=optional


FROM oven/bun:1.3.11-slim AS runtime

# Unprivileged. The base image ships a `bun` user; the vault mount should be readable by it
# (and writable only if you are not running with VAULT_READ_ONLY=true).
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml ./
COPY src ./src

# Written at runtime: the token store defaults to ./tokens.json and logs to ./logs. Create them
# owned by the runtime user so the server can write without running as root. Mount a volume over
# either one to persist it across container replacement.
RUN mkdir -p /app/logs && chown -R bun:bun /app/logs /app

USER bun

ENV NODE_ENV=production
ENV PORT=3456

EXPOSE 3456

# Liveness only — deliberately does not use /health, which is default-closed (404 without
# HEALTH_TOKEN) and would make an unconfigured deployment look permanently unhealthy. Any HTTP
# response from /mcp, including the expected 401, proves the server is up and serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/mcp',{method:'POST'}).then(()=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
