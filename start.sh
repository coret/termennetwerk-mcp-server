#!/bin/bash
# Supervisor entry point for the public server (see README, Deployment).
set -e
cd "$(dirname "$0")"

export NODE_ENV=production
export PORT=3004
export REDIS_URL=redis://localhost:6379/9
export LOG_LEVEL=info
# export ALLOWED_ORIGINS=
# export RATE_LIMIT_PER_MIN=60

exec node dist/server.js
