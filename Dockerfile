# syntax=docker/dockerfile:1.7
# Kavach: Angular SPA + NestJS API in one image, served on :8080.
#   docker build --platform linux/amd64 -t kavach .
#   docker run -p 8080:8080 -e KAVACH_BACKEND=mock kavach        # offline mock, no Snowflake needed
# In SPCS the same image runs with KAVACH_BACKEND=snowflake (see deploy/spcs/kavach-service.yaml).

# ---------------------------------------------------------------- 1. web (Angular)
FROM node:24-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- 2. api (NestJS)
FROM node:24-slim AS api
WORKDIR /src/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api/tsconfig.json api/tsconfig.build.json ./
COPY api/src ./src
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------- 3. runtime
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    KAVACH_BACKEND=auto \
    WEB_DIST=/app/web/dist/kavach-web/browser
WORKDIR /app
COPY --from=api /src/api/package.json ./api/package.json
COPY --from=api /src/api/node_modules ./api/node_modules
COPY --from=api /src/api/dist ./api/dist
COPY --from=web /src/web/dist/kavach-web/browser ./web/dist/kavach-web/browser
# Offline mock inputs (KAVACH_BACKEND=mock, or auto with no Snowflake credentials)
COPY data/out ./data/out
COPY semantic_model ./semantic_model
USER node
WORKDIR /app/api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
