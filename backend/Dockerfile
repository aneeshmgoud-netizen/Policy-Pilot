# syntax=docker/dockerfile:1
#
# Build context is this `backend/` directory (not the repo root). backend's
# dependencies are plain semver ranges with no workspace-protocol reference to
# frontend, so it installs and locks fine on its own — no need to drag the
# root npm-workspaces lockfile into the image.

# ---- builder --------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma shells out to `openssl` to detect which libssl the query engine
# binary should link against; without it present it silently guesses wrong
# (openssl-1.1.x) and the engine fails to load at runtime against Alpine's
# actual libssl.so.3.
RUN apk add --no-cache openssl

COPY package.json ./
# No package-lock.json is copied in: `npm install` resolves against the
# registry and writes one, which the production stage then installs from
# with `npm ci` for a reproducible install.
RUN npm install

COPY . .
RUN npx prisma generate
RUN npm run build

# ---- production -------------------------------------------------------
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

# Same reason as the builder stage: the query engine .so dynamically links
# against libssl.so.3 at runtime, which needs the `openssl` package present.
RUN apk add --no-cache openssl

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

# Prisma's generated client (node_modules/.prisma) contains a query-engine
# binary compiled for the platform it was generated on. Copying it from the
# builder stage — built on the same node:20-alpine base — is faster and more
# reliable than re-running `prisma generate` here, which would require
# reinstalling the `prisma` CLI devDependency we just omitted above.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# node:alpine ships a built-in unprivileged `node` user (uid 1000); the app
# never needs root.
RUN chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/src/main.js"]
