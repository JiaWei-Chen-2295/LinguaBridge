FROM node:22-bookworm-slim AS build

WORKDIR /workspace

COPY packages/mock-models/package*.json packages/mock-models/
COPY packages/protocol/package*.json packages/protocol/
COPY packages/protocol/tsconfig.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
RUN npm --prefix packages/mock-models install

COPY packages/mock-models packages/mock-models
RUN npm --prefix packages/mock-models run build

COPY apps/gateway/package*.json apps/gateway/
RUN npm --prefix apps/gateway install

COPY apps/gateway apps/gateway
RUN npm --prefix apps/gateway run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace

COPY --from=build /workspace/packages/mock-models /workspace/packages/mock-models
COPY --from=build /workspace/apps/gateway /workspace/apps/gateway

EXPOSE 4318
CMD ["node", "apps/gateway/dist/main.js"]
