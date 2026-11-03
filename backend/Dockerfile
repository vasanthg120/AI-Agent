# NestJS backend. Three stages: production dependencies (bcrypt is a native
# module, so it is compiled where the build tools are), the TypeScript build,
# and a small runtime image that runs as the unprivileged `node` user.

FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY --from=build /app/dist ./dist
# `docker compose exec backend node scripts/create-admin.js` creates the first admin on a new server.
COPY scripts ./scripts
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
