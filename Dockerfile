FROM node:24-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-bookworm-slim AS server-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build
# The runtime image copies node_modules straight out of this stage, so strip devDependencies
# (typescript, tsx, vitest, supertest, @types/*) after the build has consumed them.
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-build /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/package.json ./package.json
COPY --from=web-build /app/web/dist ./web-dist

ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/web-dist
ENV DATA_DIR=/data
ENV DB_PATH=/data/sfcowboy.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
