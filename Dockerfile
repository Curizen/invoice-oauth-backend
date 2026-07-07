# --- Build stage ---
FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY db ./db
COPY public ./public

RUN groupadd -r appuser && useradd -r -g appuser appuser
USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
