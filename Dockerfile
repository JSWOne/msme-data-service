# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs20-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER nonroot
EXPOSE 8080
CMD ["dist/index.js"]
