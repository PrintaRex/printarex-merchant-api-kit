# Build from the repository root: docker build -f starter/Dockerfile -t printarex-merchant-starter .
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

ENV NODE_ENV=production \
    PORT=3000 \
    STARTER_DATA_DIR=/data

WORKDIR /kit/starter
COPY starter/package.json ./package.json
COPY starter/src ./src
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "src/main.ts"]
