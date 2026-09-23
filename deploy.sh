#!/bin/bash

set -e

APP_DIR="/var/www/AI-Agent"

echo "======================================"
echo "Starting AI Agent deployment"
echo "======================================"

cd "$APP_DIR"

echo "Pulling latest main branch..."

git fetch origin main
git reset --hard origin/main

echo "Building containers..."

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  build

echo "Starting services..."

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d