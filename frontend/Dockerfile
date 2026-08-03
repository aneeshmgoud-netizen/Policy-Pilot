# syntax=docker/dockerfile:1
#
# Build context is this `frontend/` directory. Like the backend, frontend has
# no workspace-protocol dependency on the other package, so it installs and
# builds standalone.

# ---- builder ----------------------------------------------------------
# Kept in lockstep with the Node version pinned in CI (.github/workflows/ci.yml)
# and used locally.
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

# Baked in at build time (Vite only reads import.meta.env.VITE_* during
# `vite build`, not at container runtime) — defaults to the same value the
# app already falls back to in api-client.ts, so it works out of the box
# against the `api` service published on the host. Override with
# `--build-arg VITE_API_BASE_URL=...` for a different deployment target.
ARG VITE_API_BASE_URL=http://localhost:3000/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# ---- production -------------------------------------------------------
FROM nginx:1.27-alpine AS production

COPY nginx.conf /etc/nginx/conf.d/default.conf
# Official nginx:alpine already creates an unprivileged `nginx` user; running
# fully as that user (rather than just its worker processes) additionally
# needs the pid file and cache/temp dirs to be writable by it, and the listen
# port moved above 1024 (done in nginx.conf).
RUN sed -i 's#/run/nginx.pid#/tmp/nginx.pid#' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /var/cache/nginx /usr/share/nginx/html

COPY --from=builder --chown=nginx:nginx /app/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
