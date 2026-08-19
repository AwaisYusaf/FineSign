# FineSign API server. Multi-stage: build the whole monorepo, then run the
# compiled server. LibreOffice (writer) is installed so DOCX→PDF works out of the box.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm install --legacy-peer-deps \
 && npm run build

FROM node:20-bookworm-slim
# libreoffice-writer enables DOCX normalization; omit it to shrink the image if you
# only ever sign PDFs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
ENV NODE_ENV=production \
    PORT=4000 \
    FINESIGN_DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 4000
VOLUME ["/data"]
CMD ["node", "packages/server/dist/index.js"]
