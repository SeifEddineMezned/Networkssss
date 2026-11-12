#!/usr/bin/env bash
# One-shot VPS setup (Ubuntu 22.04/24.04). Run as root on the VPS:
#   curl/scp this repo to the VPS, then:  sudo bash scripts/deploy/setup-ubuntu.sh
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# 1. Node.js 22 LTS (the code has no npm dependencies)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

# 2. service user + code in /opt/pvp
id pvp >/dev/null 2>&1 || useradd --system --home /opt/pvp --shell /usr/sbin/nologin pvp
mkdir -p /opt/pvp
cp -r "$REPO_DIR"/. /opt/pvp/
mkdir -p /opt/pvp/server/data /opt/pvp/logs
chown -R pvp:pvp /opt/pvp

# 3. host firewall (ufw). DON'T FORGET THE CLOUD FIREWALL TOO (see RUNBOOK.md step 2)
if command -v ufw >/dev/null; then
  ufw allow OpenSSH
  ufw allow 9000/tcp
  ufw allow 9001/udp
  ufw --force enable
  ufw status verbose
fi
# Oracle Cloud Ubuntu images ship iptables rules that REJECT everything; open the ports there too:
if iptables -S INPUT 2>/dev/null | grep -q REJECT; then
  iptables -I INPUT 5 -p tcp --dport 9000 -j ACCEPT
  iptables -I INPUT 5 -p udp --dport 9001 -j ACCEPT
  (command -v netfilter-persistent >/dev/null && netfilter-persistent save) || true
fi

# 4. systemd services
cp /opt/pvp/scripts/deploy/pvp-tcp.service /opt/pvp/scripts/deploy/pvp-udp.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pvp-tcp pvp-udp
sleep 1
systemctl --no-pager status pvp-tcp pvp-udp | head -30
ss -lntup | grep -E ':900[01]' || true
echo "Public IP: $(curl -s https://api.ipify.org || echo '?')"
echo "Now run on each laptop:  node scripts/netcheck.js <PUBLIC_IP>"
