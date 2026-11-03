#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 LTS EC2 instance for HaiVE.
# Run on the server as the default `ubuntu` user:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/deploy/ec2-bootstrap.sh -o ec2-bootstrap.sh
#   sudo bash ec2-bootstrap.sh
#
# (For a private repository, copy the file up with scp instead.) Safe to run again: every step
# checks before it changes anything. It installs Docker + Compose, Nginx, Certbot, the AWS CLI,
# a firewall, fail2ban, automatic security updates and a swap file, and creates the `deploy`
# user that GitHub Actions logs in as.
set -euo pipefail

DEPLOY_USER="deploy"
APP_DIR="/var/www/AI-Agent"
SWAP_SIZE_GB=4

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
say() { echo; echo "==> $*"; }

say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg git jq unzip ufw fail2ban unattended-upgrades \
  nginx certbot python3-certbot-nginx

say "Docker Engine and the Compose plugin (from Docker's own repository)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Container logs rotate even for anything started outside docker-compose.prod.yml.
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
JSON
fi
systemctl enable --now docker
systemctl restart docker

say "AWS CLI v2 (backups to S3)"
if ! command -v aws >/dev/null; then
  arch="$(uname -m)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o /tmp/awscliv2.zip
  unzip -q -o /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi

say "Swap (${SWAP_SIZE_GB} GB) — a safety net for memory spikes, not extra RAM"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l "${SWAP_SIZE_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

say "Deploy user '$DEPLOY_USER' (GitHub Actions logs in as this user; it can run Docker, nothing else as root)"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

say "Application directory $APP_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" /var/backups/haive
install -d /var/www/certbot

say "SSH: keys only, no root login"
cat > /etc/ssh/sshd_config.d/90-haive.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxAuthTries 3
SSHD
systemctl reload ssh || systemctl reload sshd || true

say "Firewall: SSH, HTTP and HTTPS only"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

say "fail2ban (bans repeated SSH login failures)"
cat > /etc/fail2ban/jail.d/sshd.local <<'JAIL'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
JAIL
systemctl enable --now fail2ban
systemctl restart fail2ban

say "Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

say "Checks"
docker --version
docker compose version
nginx -v
certbot --version
aws --version
swapon --show
ufw status

cat <<NEXT

Done. Next (docs/deployment/AWS-EC2.md):
  4. Put the GitHub Actions public key in /home/$DEPLOY_USER/.ssh/authorized_keys
  5. As $DEPLOY_USER: clone the repository into $APP_DIR and create the three .env files
  6. Nginx site + HTTPS with certbot
NEXT
