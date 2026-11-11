# 三个后端服务共用的镜像（docs/backend/R1-09）：
#   构建阶段用 esbuild 把服务打成一个 JS 文件，运行阶段只有 Node 和这个文件。
#   docker build -f deploy/Dockerfile --build-arg SERVICE=gateway .
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY . .
# 公司代理等需要额外根证书时：docker build --secret id=ca,src=<证书> …；不传则忽略
RUN --mount=type=secret,id=ca,required=false \
    NODE_EXTRA_CA_CERTS=$([ -f /run/secrets/ca ] && echo /run/secrets/ca) \
    pnpm install --frozen-lockfile --filter "@indoorkit/device-sim..." --filter "@indoorkit/ingest..." --filter "@indoorkit/gateway..."
ARG SERVICE
RUN test -n "$SERVICE" && pnpm --filter "./services/${SERVICE}" run bundle

FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/services/${SERVICE}/dist/main.js ./main.js
USER node
CMD ["node", "main.js"]
