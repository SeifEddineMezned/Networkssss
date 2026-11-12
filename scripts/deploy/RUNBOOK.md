# Cross-network runbook (bonus)

Goal: the server runs on a machine with a **public IP**, and the 3 clients are on **3 different networks**
(campus Wi-Fi, phone hotspot A, phone hotspot B / home). Everything still uses only raw TCP or raw UDP.

> **PaaS (Render, Railway, Heroku, Fly free tier, ...) does NOT work**: they only expose HTTP(S)/TCP
> through a proxy, never raw UDP on a port you choose. Use a **VPS with a public IPv4**.

Free or cheap options: Oracle Cloud "Always Free" (Ampere / E2.1.Micro), Google Cloud e2-micro free tier,
AWS Lightsail ($3.50–5), Hetzner CX22 (~4 €), DigitalOcean ($4–6), or Azure for Students (free credit).

---

## 1. Create the VPS

- Ubuntu 22.04 or 24.04, smallest size, **public IPv4** enabled.
- Note the public IP: `PUBLIC_IP`.

## 2. Open the CLOUD firewall (people always forget this one)

The provider has its own firewall **in front of** the VM. ufw inside the VM is not enough.

| Provider | Where | Rules to add (ingress) |
|---|---|---|
| Oracle Cloud | VCN → Subnet → Security List (or NSG) | TCP 9000 from 0.0.0.0/0, **UDP 9001** from 0.0.0.0/0 |
| AWS EC2 / Lightsail | Security Group / Lightsail "Networking" tab | Custom TCP 9000, Custom UDP 9001, source 0.0.0.0/0 |
| Google Cloud | VPC network → Firewall → Create rule | tcp:9000, udp:9001, source 0.0.0.0/0, target = your VM tag |
| Azure | VM → Networking → Inbound port rules | 9000 TCP, 9001 UDP, Any source |
| DigitalOcean / Hetzner | Cloud Firewall (if you attached one) | TCP 9000, UDP 9001 |

## 3. Install and start the servers

```bash
# from your laptop (repo root)
scp -r ./ ubuntu@PUBLIC_IP:~/pvp          # or: git clone <your repo> on the VPS
ssh ubuntu@PUBLIC_IP
cd ~/pvp && sudo bash scripts/deploy/setup-ubuntu.sh
```

The script installs Node 22, copies the code to `/opt/pvp`, opens `9000/tcp` and `9001/udp` in ufw
(and in Oracle's iptables), and installs two systemd units: `pvp-tcp` and `pvp-udp`.

Manual equivalent:

```bash
sudo ufw allow 9000/tcp && sudo ufw allow 9001/udp && sudo ufw enable
sudo cp scripts/deploy/pvp-*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pvp-tcp pvp-udp
```

## 4. Logs (show these during the demo: they print each client's public address)

```bash
journalctl -u pvp-tcp -f          # TCP version
journalctl -u pvp-udp -f          # UDP version
sudo ss -lntup | grep 900         # are we listening?
sudo systemctl restart pvp-udp    # restart one version
```

Each `connect` line shows `from <public-ip>:<port>`; for UDP also `address change ... (NAT rebinding)`
if a hotspot NAT changes the client's port.

## 5. Prove it from every laptop BEFORE the demo

```bash
node scripts/netcheck.js PUBLIC_IP
```

Expected: `[TCP] OK` and `[UDP] OK`, plus **"server sees you as"** = that network's public IP. Take a
screenshot on each laptop: 3 different public IPs = cross-network proof for the slides.

## 6. Play

Each laptop: `node bridge/bridge.js --proto udp --server PUBLIC_IP:9001` (or `--proto tcp --server PUBLIC_IP:9000`),
then open http://localhost:8080.

## Troubleshooting

| Symptom | Cause |
|---|---|
| netcheck TCP `timeout` | cloud firewall or ufw missing 9000/tcp, wrong IP |
| netcheck TCP `ECONNREFUSED` | port open but server not running (`systemctl status pvp-tcp`) |
| TCP OK, UDP no echo | UDP rule missing in the **cloud** firewall (most common), or the network (some campus Wi-Fi) blocks outbound UDP → use a phone hotspot |
| Works from hotspot, not from campus Wi-Fi | campus network blocks non-HTTP ports → show the TCP version from there, or hotspot |

---

## Fallback: no VPS → Tailscale (flag clearly: it is a virtual network)

1. Install Tailscale on the server laptop and the 3 client laptops, log in with the same account.
2. `tailscale ip -4` on the server laptop → `100.x.y.z`.
3. Clients: `node bridge/bridge.js --proto udp --server 100.x.y.z:9001`.

Tailscale builds an encrypted WireGuard **UDP** tunnel between the machines (NAT traversal, relays
through DERP if direct UDP fails). Our raw TCP/UDP packets travel *inside* it. It proves cross-network
play but the path is a virtual overlay network: say so in the slides. Allow the ports on the server
laptop's firewall for the `Tailscale` interface (see docs/README.md, firewall section).

## Fallback 2: server at home behind a router

Port-forward 9000/tcp and 9001/udp on the home router to the server laptop, use the home public IP.
Fails if the ISP uses CGNAT (WAN IP in the router ≠ the IP shown by https://api.ipify.org).
