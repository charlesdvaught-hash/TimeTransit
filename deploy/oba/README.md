# Self-hosted OneBusAway on Oracle A1 — runbook

Target: `http://<vm-ip>:8080/onebusaway-api-webapp/api/where/*` answering
predicted arrivals for OCTA. ~30–60 min of clicks + one paste session.

## 1. Create the VM (Oracle console)

Compute → Instances → Create instance:

- **Name**: `oba-socal`
- **Image**: Canonical Ubuntu **22.04 aarch64** (ARM — the A1 shape forces it)
- **Shape**: Change shape → Ampere → `VM.Standard.A1.Flex` →
  **2 OCPU / 12 GB** (Always-Free allows 4 OCPU + 24 GB total per tenancy;
  12 GB leaves headroom for the bundle build + postgres)
- **Networking**: defaults; make sure "Assign a public IPv4 address" is on
- **SSH keys**: "Generate a key pair for me" → **Save private key** (you get
  one shot at the download)

**Out of capacity?** Normal for A1. Retry: pick a different availability
domain, drop to 1 OCPU/6 GB, or try again later — persistence wins. Regions
near OC: `us-sanjose-1`, `us-phoenix-1` (any region works).

## 2. Open port 8080 (two firewalls, both required)

**VCN**: Instance details → its Subnet → Security List → Add Ingress Rules →
`0.0.0.0/0`, TCP `8080`.

**On-box** (OCI Ubuntu blocks non-22 by default):

```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8080 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Install + launch (SSH: `ssh -i key.pem ubuntu@<vm-ip>`)

```
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git curl
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/OneBusAway/docker.git oba && cd oba
curl -o docker-compose.override.yml \
  https://raw.githubusercontent.com/charlesdvaught-hash/TimeTransit/main/deploy/oba/docker-compose.override.yml
export OBA_API_KEY=<pick-a-random-string>
docker compose -f docker-compose.standalone.yml -f docker-compose.override.yml up -d oba_database_pg oba_app
docker compose -f docker-compose.standalone.yml logs -f oba_app
```

First boot builds the transit bundle — expect **10–30 min** of log noise
(GTFS download, graph build) before Tomcat serves. `mysql`/`oba_database`
is intentionally not started; postgres is what `JDBC_URL` points at.

## 4. Verify

```
curl "http://localhost:8080/onebusaway-api-webapp/api/where/current-time.json?key=<key>"
curl "http://localhost:8080/onebusaway-api-webapp/api/where/agencies-with-coverage.json?key=<key>"
```

Then eyeball a real stop — grab a stop_id from `public/scan/octa.json`
(`stops[].i`) and hit
`/api/where/arrivals-and-departures-for-stop/1_<stopId>.json?key=<key>` —
predicted vs scheduled arrivals should differ on live routes (e.g. route 55).

## 5. Wire TimeTransit (after the spike convinces)

Worker route `/oba/*` → `http://<vm-ip>:8080/onebusaway-api-webapp/api/where/*`
with `OBA_KEY` + `OBA_BASE` worker vars, then a `"oba"` entry in
`src/liveSource.ts` ahead of `transit` — the fallback chain already absorbs
VM hiccups. Weekly GTFS refresh = the Devin-automation cron job from
`onebusawaybrainstorm.txt` (OCTA feed currently expires 2027-02-13).
