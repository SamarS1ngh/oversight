FROM oven/bun:1.3-alpine
WORKDIR /app

# install deps first for layer caching
COPY package.json bun.lock* ./
RUN bun install

COPY . .

EXPOSE 8080

# push schema, seed a demo user+camera (idempotent), then boot the API
CMD ["sh", "-c", "bunx drizzle-kit push --force && bun run src/seed.ts && bun run src/index.ts"]
