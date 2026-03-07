# VLESS/V2Ray Private Runbook (Kamatera VPS)

This is a private operator runbook for your current VLESS server setup on the same VPS that runs OpenClaw.

## Current Deployment (Live)

- VPS hostname: `openclaw-gateway-01`
- VPS public IP: `83.229.71.240`
- SSH user: `root`
- VLESS protocol: `vless` over `tcp` with `Reality`
- VLESS port: `443`
- UUID: `c93177ee-e55b-4ce6-b2d3-bb8059cfbfb6`
- Flow: `xtls-rprx-vision`
- Server name (SNI): `www.microsoft.com`
- Public key: `M0gtVEsjc0c8MGRsb0VRnu_iD8DKoBlIYJJisHbAiiU`
- Short ID: `d354b62c2d3dec39`
- Xray config path: `/usr/local/etc/xray/config.json`
- Xray service name: `xray`
- Backup of previous config: `/usr/local/etc/xray/config.json.pre-reality-20260306T081953Z`
- OpenClaw remains loopback-only on `127.0.0.1:18789` and `127.0.0.1:18792`

## SSH Keys on This Mac

- Primary key: `~/.ssh/openclaw_gateway_01_ed25519`
- Backup key: `~/.ssh/openclaw_kamatera`

Current permissions should be `-rw-------`.

## SSH Commands

Primary:

```bash
ssh -i ~/.ssh/openclaw_gateway_01_ed25519 root@83.229.71.240
```

Backup:

```bash
ssh -i ~/.ssh/openclaw_kamatera root@83.229.71.240
```

Quick connectivity test:

```bash
ssh -i ~/.ssh/openclaw_gateway_01_ed25519 -o ConnectTimeout=10 root@83.229.71.240 'hostname; date -u +%FT%TZ'
```

## Xray Service Operations

Service status:

```bash
systemctl status xray --no-pager
```

Enable/start:

```bash
systemctl enable --now xray
```

Restart:

```bash
systemctl restart xray
```

Logs:

```bash
journalctl -u xray -n 200 --no-pager
tail -n 100 /var/log/xray/error.log
```

Port check:

```bash
ss -ltnp | rg ':443\b'
```

Config test:

```bash
/usr/local/bin/xray run -test -config /usr/local/etc/xray/config.json
```

## Firewall Rules (UFW)

Expected allow rules include:

- `22/tcp` (SSH)
- `41641/udp` (Tailscale)
- `443/tcp` (Xray VLESS Reality)

Check:

```bash
ufw status verbose
```

Add VLESS Reality rule:

```bash
ufw allow 443/tcp comment "Xray VLESS Reality"
```

## V2Box Client Config

Use the JSON file:

- `ops/vps/v2box-vless-client.json`

That config points to:

- `address: 83.229.71.240`
- `port: 443`
- `id: c93177ee-e55b-4ce6-b2d3-bb8059cfbfb6`
- `security: reality`
- `serverName: www.microsoft.com`
- `publicKey: M0gtVEsjc0c8MGRsb0VRnu_iD8DKoBlIYJJisHbAiiU`
- `shortId: d354b62c2d3dec39`
- `flow: xtls-rprx-vision`

Quick URI form (manual profile entry):

```text
vless://c93177ee-e55b-4ce6-b2d3-bb8059cfbfb6@83.229.71.240:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=M0gtVEsjc0c8MGRsb0VRnu_iD8DKoBlIYJJisHbAiiU&sid=d354b62c2d3dec39&spx=%2F&type=tcp#openclaw-gateway-01
```

## Validation Checklist

1. Confirm Xray is active: `systemctl is-active xray` -> `active`
2. Confirm listener: `ss -ltnp | rg ':443\b'`
3. Confirm remote port reachability from client network.
4. On phone/laptop with V2Box enabled, check public IP:
   `https://api.ipify.org` should show `83.229.71.240`
5. Confirm OpenClaw unchanged:
   - `ss -ltnp | rg '18789|18792'`
   - OpenClaw process still running

## Troubleshooting

If SSH drops with `kex_exchange_identification: Connection closed by remote host`:

1. Use Kamatera VNC/serial console.
2. Check SSH logs:

```bash
journalctl -u ssh -f
```

3. Temporary sshd stabilization file already used on this host:
   `/etc/ssh/sshd_config.d/99-rescue.conf`

Current content:

```text
MaxStartups 300:30:600
LoginGraceTime 20
MaxSessions 50
```

4. Validate + restart ssh:

```bash
sshd -t
systemctl restart ssh
```

## Rollback (Xray only)

Restore the pre-Reality config:

```bash
cp /usr/local/etc/xray/config.json.pre-reality-20260306T081953Z /usr/local/etc/xray/config.json
systemctl restart xray
```

Close the Reality port if needed:

```bash
ufw delete allow 443/tcp
ufw allow 12359/tcp comment "Xray VLESS"
```

This rollback does not change OpenClaw.
