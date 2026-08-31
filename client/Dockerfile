# syntax=docker/dockerfile:1

# =============================================================================
# MediSense client
#
# Three stages: install, build, run. The runtime stage carries Next's
# `standalone` output — a server plus only the modules the traced routes
# actually reach — and no npm, no lockfile and no source. What ships is what
# runs.
#
#   docker build -t medisense-client \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api ./client
#   docker run -p 3000:3000 medisense-client
#
# READ THIS BEFORE BUILDING FOR AN ENVIRONMENT ---------------------------------
# NEXT_PUBLIC_* values are substituted into the JavaScript at build time, not
# read at boot. That is a property of Next, not a choice made here, and it has
# one consequence worth stating plainly: **this image is bound to the API URL it
# was built with.** Passing a different NEXT_PUBLIC_API_URL to `docker run` does
# nothing. Staging and production need separate builds.
#
# It also means anything passed here is public. The Maps key belongs in the
# browser and is expected to be restricted by HTTP referrer in the Google Cloud
# console; the API's own keys, the service-role key and the SMTP password
# belong to the API image and must never appear as a build argument here.
# =============================================================================

ARG NODE_VERSION=22


# --- install -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps

# Alpine ships musl; some of Next's optional native helpers are linked against
# glibc and fail to load without this shim. Cheap, and the failure it prevents
# is an obscure one that appears only at runtime.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# The lockfile and manifest alone, so that editing a component does not reinstall
# the dependency tree. `npm ci` rather than `npm install`: it installs exactly
# what the lockfile says and fails if the two disagree, which is the difference
# between a reproducible image and one that happens to work today.
COPY package.json package-lock.json ./
RUN npm ci


# --- build -------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder

RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Baked into the bundle. See the warning in the header.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY} \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build


# --- run ---------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 0.0.0.0 rather than the default: a server bound to localhost inside a
# container is reachable from inside that container and nowhere else, which
# looks exactly like a crashed container from the outside.

RUN apk add --no-cache libc6-compat \
    && addgroup --system --gid 10001 nodejs \
    && adduser --system --uid 10001 --ingroup nodejs nextjs

WORKDIR /app

# The three pieces of a standalone build, and all three are needed. The server
# is what runs; `.next/static` holds the hashed JS and CSS every page requests;
# `public` holds the favicon and images. Next's own documentation is explicit
# that the last two are not copied into `standalone` automatically — a build
# that ships only the first serves HTML and 404s every asset it references,
# which renders as an unstyled page rather than as an error.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

# Asks for the page a person would ask for. There is no dedicated health route
# in this app, and inventing one that always answers 200 would be a probe that
# reports success while every render is failing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
