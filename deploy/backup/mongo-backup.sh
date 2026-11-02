#!/usr/bin/env bash
# Nightly MongoDB backup: one compressed archive of the whole `agent` database — documents and
# every stored file (customer files, call recordings, finance and Business Knowledge documents
# live in GridFS inside it) — the last 2 kept on the server, every one copied to S3 (whose
# lifecycle rule decides how long they are kept there).
#
# Installed by docs/deployment/AWS-EC2.md (section 7.1) as /etc/cron.d/haive-backup:
#   30 21 * * * deploy bash /var/www/AI-Agent/deploy/backup/mongo-backup.sh >> /var/log/haive-backup.log 2>&1
#
# The S3 bucket comes from BACKUP_BUCKET in /var/www/AI-Agent/.env. Without it the backup stays
# on the server only (and says so).
set -euo pipefail

APP_DIR="/var/www/AI-Agent"
LOCAL_DIR="/var/backups/haive"
KEEP_DAYS=2
cd "$APP_DIR"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
file="$LOCAL_DIR/mongo-agent-$stamp.archive.gz"
mkdir -p "$LOCAL_DIR"

echo "[$stamp] Dumping MongoDB…"
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T mongo \
  mongodump --db agent --archive --gzip --quiet > "$file"
size="$(du -h "$file" | cut -f1)"
echo "[$stamp] Wrote $file ($size)"

if [ -n "${BACKUP_BUCKET:-}" ]; then
  aws s3 cp --only-show-errors "$file" "s3://$BACKUP_BUCKET/mongo/$(basename "$file")"
  echo "[$stamp] Copied to s3://$BACKUP_BUCKET/mongo/"
else
  echo "[$stamp] BACKUP_BUCKET is not set: this backup is on the server only."
fi

find "$LOCAL_DIR" -name 'mongo-agent-*.archive.gz' -mtime +"$KEEP_DAYS" -delete
echo "[$stamp] Done."
