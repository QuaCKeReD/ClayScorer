# ClayScorer: static PWA + small API with SQLite storage, in one dependency-free Node process.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    APP_DIR=/app/public \
    DATA_DIR=/data

WORKDIR /app
COPY server/ ./server/
COPY index.html sporting.html sportrap.html compak.html skeet.html users.html \
     manifest.json favicon.ico service_worker.js ./public/
COPY assets/ ./public/assets/
# Host file modes vary (e.g. 600 in synced folders); the app only needs to be world-readable.
RUN chmod -R a+rX /app

# Runs as the image's unprivileged `node` user (uid 1000) by default; compose can override
# with PUID/PGID so the process can write to the ./data bind mount.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "server/server.js"]
