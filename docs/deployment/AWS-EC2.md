# Deploying HaiVE to AWS EC2 — analysis, setup and CI/CD

This guide takes HaiVE from a fresh AWS account to a production server that redeploys itself
every time you push to `main` from VS Code. It is based on what the code in this repository
actually runs, and it keeps the existing architecture (Docker Compose: MongoDB, Qdrant, Redis,
the Python AI service, the NestJS backend, the React frontend).

Every command says where it runs:

| Label | Where |
|---|---|
| **[Local]** | Your VS Code terminal (Git Bash) on your computer |
| **[EC2]** | An SSH session on the server (`ssh ubuntu@<ip>` or `ssh deploy@<ip>`) |
| **[AWS]** | AWS Console, or AWS CLI on your computer with an admin profile |
| **[GitHub]** | github.com → your repository → Settings |

Replace these placeholders everywhere: `app.example.com` (your domain), `ACCOUNT_ID` (your
12-digit AWS account id), `haive-backups-xxxx` (your S3 bucket name), `sg-XXXX` (the security
group id), `<EC2-IP>` (the Elastic IP).

---

## 1. Summary

| | Recommendation |
|---|---|
| Region | **ap-south-1 (Mumbai)** — your users and customers are in India |
| Instance | **t3.large** — 2 vCPU, 8 GiB RAM, x86_64 |
| OS | **Ubuntu Server 24.04 LTS** (x86_64), supported until 2029 |
| Storage | **60 GiB gp3** root volume, encrypted (3,000 IOPS / 125 MB/s included) |
| Public address | 1 Elastic IP, DNS `A` record `app.example.com` |
| Web server | Nginx on the host + Let's Encrypt (Certbot), one domain |
| Runtime | Docker Engine + Compose plugin (the repository's existing setup) |
| Backups | Nightly `mongodump` to S3 + daily EBS snapshots (7 kept) |
| CI/CD | GitHub Actions: tests → Docker build check → SSH deploy → health check → automatic rollback |
| Cost | ≈ **$77/month** on demand (≈ $59 with a 1-year Savings Plan) |

---

## 2. Codebase analysis

### 2.1 What runs

```
                     Internet (HTTPS 443)
                            │
                    ┌───────▼────────┐  host Nginx + Let's Encrypt
                    │ app.example.com│  /        → frontend
                    └──┬─────┬────┬──┘  /api/    → backend   (/api removed)
                       │     │    │     /socket.io/ → backend (websockets)
         ┌─────────────▼┐ ┌──▼────▼──────────┐
         │ frontend     │ │ backend (NestJS) │ :3000  REST + Socket.IO, crons,
         │ nginx :5173  │ │ Node 22          │        webhooks, payments, OAuth
         └──────────────┘ └──┬──────┬────┬───┘
                             │      │    │ HTTP (JWT)
                             │      │  ┌─▼──────────────────────┐
                             │      │  │ python-agent (FastAPI) │ :8000  LLM agents, RAG,
                             │      │  │ Python 3.12, uvicorn   │        embeddings, CRM sync,
                             │      │  └──┬───────┬─────────┬───┘        reports, email AI
                       ┌─────▼──┐ ┌─▼─────▼─┐ ┌───▼────┐
                       │MongoDB │ │ Redis 7 │ │ Qdrant │
                       │7 :27017│ │ :6379   │ │ :6333  │
                       └────────┘ └─────────┘ └────────┘
       (everything except Nginx listens on 127.0.0.1 only — docker-compose.prod.yml)
```

| Component | Technology (from the code) | Notes that drive sizing |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript, served by Nginx (`frontend/Dockerfile`) | Static files; tiny at runtime. The API address is baked in at build time (`VITE_API_URL`). |
| Backend | NestJS 10 on Node 22 (`backend/`), Mongoose, Socket.IO (`/chat`, `/call-copilot`), BullMQ on Redis, `@nestjs/schedule` crons, bcrypt, pdfkit, exceljs, geoip-lite, Stripe/Razorpay/Cashfree SDKs | **Measured peak 342 MB RSS.** Crons every 5 min (billing holds, follow-ups, cloud-file sync), hourly (entitlements, renewals). Uploads up to 25 MB (documents), 100 MB (cloud), 300 MB (call recordings, disk-buffered). |
| AI service | FastAPI + uvicorn (1 worker), LangGraph/LangChain, Anthropic SDK, Groq, CrewAI 0.130 (+ChromaDB, ONNX Runtime), mem0, **sentence-transformers (PyTorch)**, Qdrant client, pandas, APScheduler | **Measured peak 887 MB RSS, 500 threads.** Loads the MiniLM embedding model in-process; CRM sync every 2 min, RAG sync every 20 min, scheduled reports. Mostly waits on external LLM APIs; CPU bursts on embeddings and document parsing. |
| MongoDB 7 | Documents **and files** (GridFS buckets: `customer_files`, `call_recordings`, finance and Business Knowledge documents) | Today 17 MB. Growth is driven by stored files, mainly call recordings. WiredTiger cache capped at 1 GB in production. |
| Redis 7 | BullMQ queues, caches | Capped at 256 MB, persisted (AOF), `noeviction` (BullMQ needs it). |
| Qdrant 1.12 | RAG vectors (384-dim) + mem0 user memory | Small: well under 1 GB for this data. Pinned to v1.12.6 to match `qdrant-client==1.12.1`. |

**External services the server must reach (outbound HTTPS):** Anthropic, Groq, Sarvam, Microsoft Graph,
Google APIs, Pantheras CRM, Gorilla Dash, Plivo/Twilio, Razorpay/Stripe/Cashfree, SMTP, WhatsApp Cloud API.
No inbound port besides 80/443 is needed for them; webhooks (Plivo, Razorpay, Zapier) come in through Nginx at `https://app.example.com/api/...`; Hoops is read outbound, over HTTPS, by python-agent.

### 2.2 What had to change for production (done in this repository)

| Problem found | Effect in production | Fix |
|---|---|---|
| The backend did not trust the proxy's forwarded address | Behind Nginx every user would share **one** IP: the global 60-requests/minute limit would throttle everyone together; sessions and the audit log would show the proxy | `backend/src/main.ts`: `trust proxy` for loopback/private-network proxies only |
| The AI service's `BACKEND_URL` was not set in Compose | It defaulted to `localhost:3000` — inside its container that is itself, so **billing holds (every chat turn), notifications and the CRM bridge would fail** | `docker-compose.yml`: `BACKEND_URL: http://backend:3000` |
| The frontend image was built without `VITE_API_URL` | The bundle would call `http://localhost:3000` from every visitor's browser | `frontend/Dockerfile` build args; set on the server and in GitHub |
| `qdrant/qdrant:latest` | A restart could upgrade the vector database under the pinned 1.12 client | Pinned `v1.12.6` in `docker-compose.prod.yml` |
| The default PyTorch wheel includes CUDA (several GB) | Huge image, slow builds, wasted disk on a CPU-only server | `python-agent/Dockerfile` installs the CPU wheel (`torch==2.5.1`) first |
| `npm install` in the backend image's final stage | bcrypt (native) could fail to build without compilers; versions not locked | `backend/Dockerfile`: `npm ci`, dependencies compiled in a stage with build tools, runs as user `node` |
| MongoDB cache unbounded, Redis not persisted, container logs unbounded | MongoDB takes half the RAM; queued jobs lost on restart; logs can fill the disk | `docker-compose.prod.yml` |
| The old workflow deployed without testing; `deploy.sh` had no health check or rollback | A broken commit went straight to production | New `.github/workflows/deploy.yml` and `deploy.sh` |

---

## 3. Instance recommendation

### 3.1 Memory budget (the deciding factor)

| Process | Measured / configured | Budget |
|---|---|---|
| Ubuntu, sshd, Nginx, Docker daemon, containerd | — | 0.6 GB |
| MongoDB | 154 MB today; WiredTiger cache capped at 1 GB | 1.2 GB |
| AI service (Python) | 887 MB peak in development; RAG, mem0, reports and document parsing add more under real load | 1.5–2.0 GB |
| Backend (Node) | 342 MB peak | 0.5–0.7 GB |
| Qdrant | small collections | 0.3–0.5 GB |
| Redis | capped | 0.3 GB |
| Frontend Nginx | — | < 0.05 GB |
| **Total at peak** | | **≈ 4.5–5.3 GB** |
| Docker build during a deploy (`deploy.sh` builds on the server) | Vite + tsc + pip | +1.5–2 GB for a few minutes |

**t3.large (8 GiB)** holds the peak with ~3 GB to spare, and a deploy's build fits beside the running app.
A 4 GiB instance (t3.medium) would already be full at peak and would swap during every deploy — not suitable.
The 4 GB swap file the setup script creates is a safety net, not capacity.

### 3.2 CPU

The workload is mostly I/O: requests wait on Anthropic/Groq, CRM and Microsoft APIs. CPU bursts come from
embeddings (MiniLM on CPU), bcrypt at sign-in, parsing uploaded documents (pandas/pypdf/docx), PDF/Excel
generation and the build during a deploy. **2 vCPU** is right. A **burstable t3** fits this shape: its
baseline is 30 % of each vCPU, it earns credits while idle and spends them on bursts (and in the default
*unlimited* mode it never slows down — sustained use above baseline is billed as surplus credits).

**Watch after go-live (CloudWatch, 2–4 weeks):** if `CPUUtilization` averages above ~35 % or
`CPUSurplusCreditsCharged` appears every day, move to **m7i-flex.large** (same 8 GiB, no credits). If memory
stays above ~75 %, move to **t3.xlarge** (16 GiB). Both are a stop → change type → start, with the same disk.

### 3.3 Architecture and OS

- **x86_64**, not ARM (Graviton): PyTorch, ONNX Runtime, ChromaDB and bcrypt are built and tested most widely
  on x86_64, and GitHub's standard runners build x86_64 images natively. Graviton (`t4g.large`, ~20 % cheaper)
  is a later saving once the images are built and tested for arm64.
- **Ubuntu 24.04 LTS**: Docker's official packages support it, Certbot and Nginx come from Ubuntu, security
  updates until 2029.
- **Why not** Elastic Beanstalk, ECS/Fargate, RDS/DocumentDB or a load balancer: they would replace the existing
  Compose architecture and multiply the cost (an ALB alone is ~$20/month) without a need at this scale.
  DocumentDB is also not fully MongoDB-compatible. One well-backed-up instance is the right step now.

---

## 4. Storage plan

**One 60 GiB gp3 root volume, encrypted.** gp3 includes 3,000 IOPS and 125 MB/s at no extra cost, far
beyond this workload.

| Item | Size | Basis |
|---|---|---|
| Ubuntu + packages | 4 GB | |
| Docker images | 8–10 GB | python-agent ≈ 2.5 GB (CPU PyTorch), backend ≈ 0.3 GB, mongo ≈ 0.8 GB, qdrant/redis/nginx ≈ 0.3 GB; the last 5 builds of each app image are kept for rollbacks (they share most layers) plus build cache (pruned weekly) |
| Swap file | 4 GB | |
| MongoDB data (incl. GridFS files) | 20 GB first year | 17 MB of documents today; files dominate: e.g. 100 call recordings/month × 15 MB ≈ 1.5 GB/month, plus customer and Business Knowledge documents |
| Qdrant | 1–2 GB | 384-dim vectors |
| Redis (AOF) | < 0.5 GB | capped at 256 MB in memory |
| Local backups | 2 × database size | the last 2 nightly dumps; older ones live in S3 only |
| Logs | < 1 GB | containers rotate at 10 MB × 5; journald |
| Upload temp space | 1 GB | up to 300 MB per call recording while it is processed |
| **Total, year 1** | **≈ 45–52 GB** | → **60 GiB** |

**Growing the disk later** (no downtime): [AWS] EC2 → Volumes → Modify → new size, then
**[EC2]** `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1 && df -h /`.

---

## 5. Setting up AWS

### Step 1 — AWS account basics [AWS]
1. Sign in as the root user once: enable **MFA** on root, then create an **IAM user (or IAM Identity Center user) with
   AdministratorAccess and MFA** for yourself, and stop using root.
2. Top-right region selector → **Asia Pacific (Mumbai) ap-south-1**.
3. Billing → **Budgets** → create a monthly cost budget of $100 with an email alert at 80 %.

### Step 2 — Security group [AWS]
EC2 → Security Groups → Create: name `haive-web`.

| Type | Port | Source | Why |
|---|---|---|---|
| HTTP | 80 | 0.0.0.0/0, ::/0 | Let's Encrypt and the redirect to HTTPS |
| HTTPS | 443 | 0.0.0.0/0, ::/0 | the app |
| SSH | 22 | **My IP** | you |

GitHub Actions also needs SSH. Choose one:
- **Recommended:** keep port 22 limited to your IP and set up the optional "SSH gate" in section 8.4 — the workflow
  opens port 22 for its own IP only while it deploys.
- **Simpler:** allow port 22 from `0.0.0.0/0`. The server allows keys only, no passwords, no root, and fail2ban
  bans repeated failures — acceptable, but the port is visible to the internet.

Note the group id (`sg-XXXX`).

### Step 3 — IAM role for the server (backups) [AWS]
1. Create the backup bucket (section 7.1) first, or note the name you will use.
2. IAM → Roles → Create role → trusted entity **AWS service: EC2**. Attach **AmazonSSMManagedInstanceCore**
   (lets you open a shell from the AWS console if SSH is ever locked out).
3. Add an inline policy named `haive-backups-s3` (least privilege: write and read backups, never delete):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::haive-backups-xxxx/mongo/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::haive-backups-xxxx",
      "Condition": { "StringLike": { "s3:prefix": ["mongo/*"] } } }
  ]
}
```
4. Name the role `haive-ec2`.

### Step 4 — Launch the instance [AWS]
EC2 → Launch instance:

| Setting | Value |
|---|---|
| Name | `haive-prod` |
| AMI | **Ubuntu Server 24.04 LTS (HVM), SSD Volume Type — 64-bit (x86)** |
| Instance type | **t3.large** |
| Key pair | Create new → `haive-admin` (ED25519, .pem) — keep it safe, this is your own login |
| Network | default VPC, a public subnet, **Auto-assign public IP: Enable** |
| Security group | `haive-web` |
| Storage | **60 GiB, gp3, Encrypted: Yes** (3000 IOPS, 125 MB/s) |
| Advanced → IAM instance profile | `haive-ec2` |
| Advanced → Termination protection | **Enable** |
| Advanced → Metadata version | **V2 only** (IMDSv2) |
| Advanced → Credit specification | Unlimited (default) |

Then EC2 → **Elastic IPs** → Allocate → Associate with `haive-prod`. This is `<EC2-IP>`; it stays the same across reboots.

**Verify [Local]:**
```bash
chmod 600 ~/Downloads/haive-admin.pem
ssh -i ~/Downloads/haive-admin.pem ubuntu@<EC2-IP> 'lsb_release -ds; nproc; free -h; df -h /'
# Ubuntu 24.04 LTS, 2, ~7.6Gi total, ~58G
```

### Step 5 — DNS [your DNS provider or Route 53]
Create an **A record**: `app.example.com` → `<EC2-IP>` (TTL 300).

**Verify [Local]:** `nslookup app.example.com` → returns `<EC2-IP>` (can take a few minutes).

---

## 6. Setting up the server

### Step 6 — Base software [EC2 as ubuntu]
The repository's `deploy/ec2-bootstrap.sh` installs and configures everything: Docker Engine + Compose plugin
(from Docker's repository), Nginx, Certbot, the AWS CLI v2, git, a 4 GB swap file, the `deploy` user (member of
the `docker` group only), SSH keys-only/no-root, the UFW firewall (22/80/443), fail2ban and automatic security updates.

[Local] copy it up (the repository is private, so not via raw.githubusercontent):
```bash
scp -i ~/Downloads/haive-admin.pem deploy/ec2-bootstrap.sh ubuntu@<EC2-IP>:~
```
[EC2]
```bash
sudo bash ~/ec2-bootstrap.sh
```
**Verify [EC2]** (the script prints these at the end):
```bash
docker --version && docker compose version     # Docker 27+, Compose v2.24+ (needed for !override)
nginx -v; certbot --version; aws --version
swapon --show                                  # /swapfile 4G
sudo ufw status                                # 22, 80, 443 allowed
id deploy                                      # groups: deploy docker
aws sts get-caller-identity                    # shows the haive-ec2 role (instance profile works)
```

### Step 7 — Keys: GitHub Actions → server, server → GitHub

**7.1 The key GitHub Actions logs in with** [Local]:
```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/haive_deploy -N ""
cat ~/.ssh/haive_deploy.pub      # → goes on the server
cat ~/.ssh/haive_deploy          # → goes into the GitHub secret EC2_SSH_KEY (section 8.2)
```
[EC2 as ubuntu] paste the **public** key:
```bash
echo "ssh-ed25519 AAAA...  github-actions-deploy" | sudo tee -a /home/deploy/.ssh/authorized_keys
```
**Verify [Local]:** `ssh -i ~/.ssh/haive_deploy deploy@<EC2-IP> 'whoami; docker ps'` → `deploy` and an empty table.

**7.2 The server's read-only access to the repository** [EC2 as deploy]:
```bash
sudo -iu deploy
ssh-keygen -t ed25519 -C "haive-server-readonly" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```
[GitHub] Repository → Settings → **Deploy keys** → Add deploy key → title `haive-prod`, paste it,
**leave "Allow write access" off**.

**Verify [EC2 as deploy]:** `ssh -T git@github.com` → answer `yes` to the host-key question once, then "Hi vasanthg120/AI-Agent! You've successfully authenticated…"

### Step 8 — Code and configuration [EC2 as deploy]
```bash
git clone git@github.com:vasanthg120/AI-Agent.git /var/www/AI-Agent
cd /var/www/AI-Agent
cp deploy/env/server.env.example            .env
cp deploy/env/backend.env.production.example backend/.env
cp deploy/env/python-agent.env.production.example python-agent/.env
chmod 600 .env backend/.env python-agent/.env
```
Generate the shared secrets once (the same values go into **both** `backend/.env` and `python-agent/.env`):
```bash
openssl rand -hex 48     # → JWT_SECRET
openssl rand -hex 32     # → ENCRYPTION_KEY
```
> If you are moving an existing installation, **reuse its current `JWT_SECRET` and `ENCRYPTION_KEY`** instead —
> a new `ENCRYPTION_KEY` makes every stored Outlook/Google/OneDrive connection unreadable.

Edit the three files (`nano .env` etc.): replace `app.example.com` with your domain, then fill in the keys
(Anthropic, Microsoft, SMTP, Razorpay…) — the same values you use in development, except the URLs.

**Verify:**
```bash
grep -c '=$' backend/.env python-agent/.env        # empty settings left (integrations you don't use may stay empty)
diff <(grep -E '^(JWT_SECRET|ENCRYPTION_KEY)=' backend/.env | sort) \n     <(grep -E '^(JWT_SECRET|ENCRYPTION_KEY)=' python-agent/.env | sort) && echo "shared secrets match"
grep -E '^VITE_' .env                              # your domain, https
```

**Moving data from an existing server or your PC (optional)** — [Local or old server]
`mongodump --uri mongodb://localhost:27017/agent --archive=agent.archive.gz --gzip`, copy it up with `scp`, then after
step 9 starts MongoDB: `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T mongo mongorestore --archive --gzip < agent.archive.gz`.

### Step 9 — First deployment, by hand [EC2 as deploy]
```bash
cd /var/www/AI-Agent
./deploy.sh "$(git rev-parse HEAD)"
```
The first run builds all images (≈ 10–20 minutes: PyTorch CPU and the embedding model are downloaded once;
later deploys rebuild only what changed, usually 2–5 minutes). It ends with **"Healthy. <sha> is live."**

**Verify:**
```bash
./deploy.sh status                               # all containers Up, "Healthy"
curl -s http://127.0.0.1:3000/health             # {"status":"ok","service":"backend"}
curl -s http://127.0.0.1:8000/health             # {"status":"ok","service":"python-agent"}
curl -sI http://127.0.0.1:5173/ | head -1        # HTTP/1.1 200 OK
docker stats --no-stream                         # memory per container
```
Create the first administrator account:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend \
  node scripts/create-admin.js you@example.com 'A-strong-password' "Your Name"
```

### Step 10 — Nginx and HTTPS [EC2 as ubuntu]
```bash
sudo cp /var/www/AI-Agent/deploy/nginx/haive.conf /etc/nginx/sites-available/haive
sudo sed -i 's/app\.example\.com/YOUR.DOMAIN/g' /etc/nginx/sites-available/haive
sudo ln -sf /etc/nginx/sites-available/haive /etc/nginx/sites-enabled/haive
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR.DOMAIN --redirect --agree-tos -m you@example.com --no-eff-email
```
Certbot adds the HTTPS server block and the HTTP→HTTPS redirect, and its systemd timer renews the certificate.

**Verify:**
```bash
curl -sI https://YOUR.DOMAIN | head -1                       # HTTP/2 200
curl -s https://YOUR.DOMAIN/api/health                       # {"status":"ok","service":"backend"}
curl -sI http://YOUR.DOMAIN | grep -i location               # → https://
sudo certbot renew --dry-run                                 # "Congratulations, all simulated renewals succeeded"
systemctl list-timers | grep certbot
```
Open `https://YOUR.DOMAIN` in a browser, sign in, open the chat (websocket) and upload a small file.

### Step 11 — Third-party settings that must point at the new address
| Service | Set to |
|---|---|
| Azure app registration (Outlook, OneDrive, Microsoft sign-in) → Authentication → Redirect URIs | `https://YOUR.DOMAIN/api/outlook/callback`, `https://YOUR.DOMAIN/api/outlook/admin-consent-callback`, `https://YOUR.DOMAIN/api/auth/oauth/microsoft/callback` |
| Google Cloud OAuth clients | `https://YOUR.DOMAIN/api/gmail/callback`, `https://YOUR.DOMAIN/api/cloud-files/google/callback`, `https://YOUR.DOMAIN/api/auth/oauth/google/callback` |
| Razorpay / Stripe / Cashfree → Webhooks | `https://YOUR.DOMAIN/api/billing/webhooks/razorpay` (or `/stripe`, `/cashfree`) |
| Plivo / Twilio | taken from `PLIVO_PUBLIC_BASE_URL` / `PUBLIC_API_BASE_URL` automatically (no ngrok in production) |
| Zapier webhooks | the address the Integrations page shows (built from `PUBLIC_API_BASE_URL`) |

---

## 7. Backups, snapshots and recovery

### 7.1 Nightly MongoDB backup to S3
[AWS CLI on your computer]
```bash
B=haive-backups-xxxx
aws s3api create-bucket --bucket $B --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-public-access-block --bucket $B --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket $B --lifecycle-configuration '{
  "Rules": [{ "ID": "keep-35-days", "Status": "Enabled", "Filter": { "Prefix": "mongo/" },
              "Expiration": { "Days": 35 }, "NoncurrentVersionExpiration": { "NoncurrentDays": 7 } }] }'
```
[EC2 as deploy] put `BACKUP_BUCKET=haive-backups-xxxx` in `/var/www/AI-Agent/.env`, then:
```bash
bash /var/www/AI-Agent/deploy/backup/mongo-backup.sh      # run once by hand
aws s3 ls s3://haive-backups-xxxx/mongo/                   # the archive is there
```
[EC2 as ubuntu] schedule it every night at 03:00 IST (21:30 UTC):
```bash
echo '30 21 * * * deploy bash /var/www/AI-Agent/deploy/backup/mongo-backup.sh >> /var/log/haive-backup.log 2>&1' | sudo tee /etc/cron.d/haive-backup
sudo touch /var/log/haive-backup.log && sudo chown deploy /var/log/haive-backup.log
```

### 7.2 Daily EBS snapshots (whole disk: MongoDB, Qdrant, Redis, configuration)
[AWS] EC2 → Elastic Block Store → **Lifecycle Manager** → Create policy → EBS snapshot policy →
target: instance `haive-prod` (or tag the volume `Backup=haive-daily` and target the tag) → every 24 hours at
20:30 UTC (02:00 IST) → **retain 7** → copy tags → create. (The console creates the default DLM role for you.)

### 7.3 Restoring
- **MongoDB from S3** [EC2 as deploy]:
  ```bash
  cd /var/www/AI-Agent
  aws s3 cp s3://haive-backups-xxxx/mongo/mongo-agent-<stamp>.archive.gz /var/backups/haive/
  # Try it beside the live data first:
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T mongo mongorestore --archive --gzip \
    --nsFrom 'agent.*' --nsTo 'agent_restore.*' < /var/backups/haive/mongo-agent-<stamp>.archive.gz
  # Replace the live database (stops nothing, replaces collections):
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T mongo mongorestore --archive --gzip --drop \
    < /var/backups/haive/mongo-agent-<stamp>.archive.gz
  ```
- **Whole server from a snapshot** [AWS]: Snapshots → select → Create volume (same AZ) → stop the instance →
  detach the old root volume → attach the new one as `/dev/sda1` → start. Or Create image → launch a new instance
  from it and move the Elastic IP.
- **Test a restore once a quarter** with the "beside the live data" command above.

### 7.4 Rolling back a deployment
| Situation | What to do |
|---|---|
| A deploy fails its health check | Nothing: `deploy.sh` starts the previous build again by itself and the Actions run turns red. |
| A deploy is healthy but has a bug | [EC2 as deploy] `cd /var/www/AI-Agent && ./deploy.sh rollback` — the previous images are still on the server (the last 5 are kept); takes seconds. |
| Make it permanent | [Local] `git revert <bad-sha> && git push` — the pipeline tests and deploys the revert. |
| Go back several releases | [EC2] `git reset --hard <sha> && ./deploy.sh <sha>` (rebuilds if that build is no longer kept). |

---

## 8. GitHub Actions CI/CD

### 8.1 What happens on every push to `main` (`.github/workflows/deploy.yml`)

```
push to main
  ├─ Backend · typecheck and tests     tsc + 636 Jest tests against a throwaway MongoDB/Redis (~5 min)
  ├─ Frontend · typecheck and build    tsc -b + vite build with the production URLs        (~2 min)
  └─ AI service · syntax check         python -m compileall                                   (<1 min)
        │ all green
        ▼
  Docker build · backend / python-agent / frontend   (all three Dockerfiles must build; cached)
        │ all green
        ▼
  Deploy to EC2 (environment "production")
     [optional] open port 22 for this runner's IP only (AWS OIDC role)
     ssh deploy@EC2: git reset --hard <sha>  →  ./deploy.sh <sha>
         build images tagged <sha>  →  docker compose up -d  →  health checks (3 min max)
         healthy → live, old builds pruned (last 5 kept)   |   not healthy → previous build restored, run fails
     [optional] close port 22 again
```
Pushes queue one after another (`concurrency`), never two deploys at once. Nothing is deployed if any test fails.

### 8.2 Repository settings [GitHub]
**Settings → Secrets and variables → Actions → Secrets:**

| Secret | Value |
|---|---|
| `EC2_HOST` | `<EC2-IP>` (or `app.example.com`) |
| `EC2_USER` | `deploy` |
| `EC2_SSH_KEY` | the whole private key from step 7.1 (`cat ~/.ssh/haive_deploy`), including the BEGIN/END lines |
| `EC2_PORT` | optional, only if SSH is not on 22 |

**Variables** (same tab → Variables):

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://app.example.com/api` |
| `VITE_SOCKET_URL` | `https://app.example.com` |

**Settings → Environments → New environment `production`** (created automatically on the first run). Optionally add
**Required reviewers** (yourself) to approve each deploy, and restrict it to the `main` branch.

### 8.3 Removing the old workflow copy
`github/workflows/deploy.yml` (without the dot) is an old copy GitHub never runs. Delete it to avoid confusion:
[Local] `git rm -r github && git commit -m "Remove unused workflow copy"`.

### 8.4 Optional: SSH gate (port 22 closed to the world)
Lets the workflow open port 22 for its own IP only while it deploys, with no AWS keys stored in GitHub.

[AWS] IAM → Identity providers → Add provider → **OpenID Connect**, URL `https://token.actions.githubusercontent.com`,
audience `sts.amazonaws.com`.

[AWS] IAM → Roles → Create role → **Web identity** → that provider → audience `sts.amazonaws.com` → then replace the
trust policy with:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:vasanthg120/AI-Agent:environment:production"
      }
    }
  }]
}
```
Inline permissions policy (it can only edit this one security group):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"],
    "Resource": "arn:aws:ec2:ap-south-1:ACCOUNT_ID:security-group/sg-XXXX"
  }]
}
```
Name it `haive-github-deploy`. [GitHub] add three **variables**: `AWS_DEPLOY_ROLE_ARN` = the role's ARN,
`AWS_REGION` = `ap-south-1`, `EC2_SECURITY_GROUP_ID` = `sg-XXXX`. Keep port 22 in the security group limited to your own IP.

### 8.5 First run
[GitHub] Actions → **Deploy to AWS** → Run workflow (or push any commit). Watch the five jobs turn green; the
deploy step's log ends with "Healthy. <sha> is live."

---

## 9. Your daily workflow

1. **[Local]** Edit in VS Code, run it locally as you do now.
2. **[Local]** Commit and push to `main` (Source Control panel → Commit → Sync, or):
   ```bash
   git add -A && git commit -m "Describe the change" && git push origin main
   ```
3. **[GitHub]** Actions tab → the run for your commit. ~10–15 minutes later it is live; a red run means
   nothing changed on the server (tests failed) or the previous version is back (health check failed).
   From the terminal: `gh run watch` (GitHub CLI).
4. **[Browser]** Hard-refresh the app (the app shell is never cached; bundles are versioned).

Recommended habit: work on a branch and open a pull request into `main`; the tests then run on the PR before anything deploys
(add `pull_request:` to the workflow's `on:` with the deploy job guarded by `if: github.event_name == 'push'` if you adopt this).

---

## 10. Verification and troubleshooting

### 10.1 Health at a glance [EC2 as deploy, in /var/www/AI-Agent]
```bash
./deploy.sh status                                                     # deployed sha, containers, health
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f --tail 100 backend   # also python-agent, mongo…
docker stats --no-stream                                               # CPU / memory per container
free -h; df -h /; docker system df                                     # RAM, disk, Docker disk use
cat .deploy/history.log                                                # every deploy and its outcome
sudo tail -f /var/log/nginx/error.log /var/log/nginx/access.log
sudo certbot certificates; sudo ufw status; sudo fail2ban-client status sshd
```

### 10.2 Common problems
| Symptom | Cause → fix |
|---|---|
| Actions: `ssh: handshake failed` / `i/o timeout` | Port 22 not open to the runner (security group / SSH gate variables), wrong `EC2_USER`, or the public key is not in `/home/deploy/.ssh/authorized_keys`. Test from your PC with the same key. |
| Actions: "Set the repository variables VITE_API_URL…" | Add the two variables (8.2). |
| Deploy: "Health check failed" and rolled back | Read the logs it printed. Usual causes: a missing/new `.env` value, `JWT_SECRET` different between backend and AI service, MongoDB not healthy (`docker compose … ps`). |
| The site calls `localhost` / login fails with network error | `VITE_API_URL` was missing when the frontend was built. Fix `.env`, then `docker rmi haive/frontend:<sha>` and `./deploy.sh <sha>` to rebuild it. |
| `502 Bad Gateway` | A container is down: `./deploy.sh status`, then its logs. |
| `413 Request Entity Too Large` | An upload above `client_max_body_size` (300 MB) in the Nginx site. |
| Chat does not update live | Websocket blocked: the `/socket.io/` block and its `Upgrade` headers must be in the Nginx site (certbot keeps them). |
| AI features answer 500/503 fast | AI service down or misconfigured: `logs python-agent`; check `ANTHROPIC_API_KEY`, `BACKEND_URL` is `http://backend:3000` (set by compose). |
| Microsoft/Google sign-in: "redirect URI mismatch" | Register the exact `https://YOUR.DOMAIN/api/...` addresses (step 11). |
| Containers restarting, `Killed` in logs | Out of memory: `dmesg -T | grep -i kill`, `docker stats`. Consider t3.xlarge (3.2). |
| Disk filling up | `docker system df`; `docker builder prune -af`; old backups in `/var/backups/haive`; grow the volume (section 4). |
| Certificate renewal failing | Port 80 must stay open; `sudo certbot renew --dry-run` shows why. |

---

## 11. Security checklist

- [x] Only 80/443 public; 22 limited to your IP (+ the deploy runner, temporarily, with the SSH gate)
- [x] MongoDB, Redis, Qdrant and the AI service listen on 127.0.0.1 only (`docker-compose.prod.yml`); UFW allows 22/80/443 only
- [x] SSH: keys only, no root login, fail2ban; GitHub deploys as `deploy` (Docker access, no sudo). Membership of the `docker` group is root-equivalent on this host, so treat the `EC2_SSH_KEY` secret like a root key: rotate it if anyone who could read it leaves
- [x] The server's repository access is a **read-only** deploy key; it holds no GitHub token
- [x] Secrets live only in `.env` files on the server (`chmod 600`) and in GitHub encrypted secrets; nothing secret is committed (`.gitignore`) or baked into images (`.dockerignore` excludes `.env`)
- [x] Integration tokens are encrypted at rest with `ENCRYPTION_KEY` (keep a copy of it in a password manager)
- [x] HTTPS with automatic renewal; HSTS; security headers; IMDSv2 only; encrypted EBS
- [x] Least-privilege IAM: the server can only put/read its own backup prefix; the GitHub role can only edit one security group
- [x] Backups: nightly logical (S3, versioned, 35 days) + daily snapshots (7); restore tested quarterly
- [x] Automatic security updates (unattended-upgrades); review `apt list --upgradable` monthly and reboot when `/var/run/reboot-required` exists
- [ ] Turn on **Required reviewers** for the `production` environment if more than one person pushes to `main`
- [ ] CloudWatch alarms: `StatusCheckFailed` (auto-recover the instance), `CPUUtilization > 80 % for 15 min`; install the CloudWatch agent if you want memory/disk metrics

---

## 12. Monthly cost (ap-south-1, on demand)

Prices are AWS list prices as published by third-party trackers at the time of writing — confirm them in the
[AWS Pricing Calculator](https://calculator.aws/) before you commit.

| Item | Basis | ≈ USD / month |
|---|---|---|
| EC2 t3.large | $0.0896/h × 730 h | 65.40 |
| EBS gp3 60 GiB | $0.0912/GB-month | 5.47 |
| Public IPv4 (Elastic IP) | $0.005/h, charged for every public IPv4 | 3.65 |
| EBS snapshots | 7 incremental daily, ≈ 20–30 GB stored, ≈ $0.05/GB-month | 1.00–1.50 |
| S3 backups | ≈ 35 dumps; grows with stored files | 0.50–3.00 |
| Data transfer out | first 100 GB/month free; a business web app rarely exceeds it | 0 |
| CloudWatch | basic metrics free; 2 alarms | 0.20 |
| **Total** | | **≈ $77–79 / month** (≈ ₹6,500) |

**Ways to pay less without risking stability**
1. **Compute Savings Plan, 1 year, no upfront** — about 25–30 % off EC2 (t3.large ≈ $47 → total ≈ $59). Buy it after
   2–4 weeks, once you are sure of the size. 3 years ≈ 50 % off.
2. **Graviton (t4g.large)** — about 20 % cheaper; needs arm64 images built and tested first (section 3.3).
3. **Right-size from data** — CloudWatch for a month; do not go below 8 GiB with this stack.
4. Keep the S3 lifecycle (35 days) and the 7-snapshot rule; prune Docker images (already automatic).
5. Avoid what this setup does not need: load balancer (~$20), NAT gateway (~$35), RDS/DocumentDB (~$60+).

---

## 13. Files in this repository

| File | Purpose |
|---|---|
| `.github/workflows/deploy.yml` | CI/CD: tests → Docker build check → deploy over SSH |
| `deploy.sh` | On the server: build the commit's images, start, health-check, roll back; `status`, `rollback` |
| `docker-compose.yml` | Services (unchanged apart from the AI service's `BACKEND_URL`) |
| `docker-compose.prod.yml` | Production: 127.0.0.1 ports, commit-tagged images, Qdrant pin, Mongo cache, Redis persistence, log rotation |
| `backend/Dockerfile`, `frontend/Dockerfile`, `python-agent/Dockerfile`, `frontend/nginx.conf` | Images (see 2.2) |
| `deploy/ec2-bootstrap.sh` | One-time server setup |
| `deploy/nginx/haive.conf` | Host Nginx site (certbot adds HTTPS) |
| `deploy/backup/mongo-backup.sh` | Nightly MongoDB backup to S3 |
| `deploy/env/*.example` | Templates for the server's three `.env` files |
| `.gitattributes` | Keeps scripts and configs LF so they run on Linux whatever OS commits them |
