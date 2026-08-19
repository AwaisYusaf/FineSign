# FineSign API server. Multi-stage: build the whole monorepo, then run the
# compiled server. LibreOffice (writer) is installed so DOCX→PDF works out of the box.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY . .
# --legacy-peer-deps is mandatory (transitive unpdf/@napi-rs/canvas peer conflict).
# The prune drops build-only dependencies before they reach the runtime image —
# the server runs the compiled dist/, so nothing there needs tsx/eslint/vite.
RUN npm install --legacy-peer-deps \
 && npm run build \
 && npm prune --omit=dev --legacy-peer-deps

FROM node:20-bookworm-slim
# libreoffice-writer enables DOCX normalization; omit it to shrink the image if you
# only ever sign PDFs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app .
ENV NODE_ENV=production \
    PORT=4000 \
    FINESIGN_DATA_DIR=/data
# Run as an unprivileged user. This process handles untrusted uploads and shells
# out to LibreOffice to convert them, so it should not be root.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
VOLUME ["/data"]
# Node 20 has a global fetch, so the check needs no extra package in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/index.js"]
