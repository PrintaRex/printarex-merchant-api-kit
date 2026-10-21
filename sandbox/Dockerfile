# Build from the repository root: docker build -f sandbox/Dockerfile -t printarex-merchant-api-sandbox .
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

ENV NODE_ENV=production \
    PORT=8080

# Same layout as the repository, so the sandbox finds ../contract at runtime.
WORKDIR /kit/sandbox
COPY contract/merchant-api-v1.openapi.yaml /kit/contract/merchant-api-v1.openapi.yaml
COPY sandbox/package.json ./package.json
COPY sandbox/src ./src

USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "src/main.ts"]
