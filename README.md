# paperclip-railway

> A Railway-ready wrapper for [paperclipai/paperclip](https://github.com/paperclipai/paperclip) with a web-based `/setup` page — no CLI access required.

Railway doesn't provide shell access during deployment, so the normal `pnpm paperclipai onboard` flow can't run. This repo solves that by:

1. On first boot, serving a **web-based setup page** at your Railway URL that checks all required env vars and walks you through configuration.
2. Once you click **Launch Paperclip**, the setup page hands off to the real Paperclip server — which automatically runs DB migrations and starts up.
3. You then visit your Railway URL and **sign up** — no CLI needed.

---

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/paperclip-ai-company?referralCode=QXdhdr&utm_medium=integration&utm_source=template&utm_campaign=generic)

### Manual steps

1. **Fork or clone this repo** into your own GitHub account.

2. **Create a new Railway project** and add:
   - A **PostgreSQL** database service (Railway managed)
   - A **new service** pointing at your fork of this repo

3. **Add a volume** to the Paperclip service, mounted at `/paperclip`.

4. **Set these environment variables** on the Paperclip service:

```env
DATABASE_URL="${{Postgres.DATABASE_URL}}"
BETTER_AUTH_SECRET="${{secret(32)}}"
PAPERCLIP_PUBLIC_URL="https://your-app.up.railway.app"
PAPERCLIP_ALLOWED_HOSTNAMES="your-app.up.railway.app"
PAPERCLIP_DEPLOYMENT_MODE="authenticated"
PAPERCLIP_HOME="/paperclip"
HOST="0.0.0.0"
PORT="3100"
NODE_ENV="production"
```

5. **Deploy** — Railway will run `npm start` which serves the setup page.

6. **Open your Railway URL** — you'll see the setup page. Verify all vars are green, then click **Launch Paperclip**.

7. **Sign up** for an account on the Paperclip UI. The first user automatically gets board-level access.

8. **Lock sign-ups**: go back to Railway Variables, add `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, and redeploy.

---

## How it works

```
npm start
  └── scripts/start.mjs
        ├── if SETUP_COMPLETE != "true" AND no /paperclip/.setup_complete file:
        │     serve setup UI on PORT  (/setup)
        │     user clicks "Launch" → writes flag → restarts as paperclip
        └── else:
              write minimal config.json to PAPERCLIP_HOME
              spawn: paperclipai run --yes --no-onboard
```

The setup page auto-polls Railway's env vars by hitting `/setup/status` — each var shows as ✓ Set or ✗ Missing in real time.

---

## Files

```
paperclip-railway/
├── package.json          # installs paperclipai, defines start script
├── scripts/
│   └── start.mjs         # setup server + paperclip launcher
└── README.md
```

---

## After first launch

Once Paperclip is running, this wrapper is transparent — it just passes through to `paperclipai run`. The `/setup` page is bypassed on all subsequent restarts (the flag file persists in the `/paperclip` volume).

---

## Troubleshooting

**Setup page keeps reappearing after redeploy**
→ The `/paperclip` volume wasn't attached. Make sure the volume is mounted at `/paperclip` in Railway's service settings.

**Auth errors / blank screen after login**
→ `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES` don't match your Railway domain. Update them and redeploy.

**`DATABASE_URL` SSL errors**
→ Add `DATABASE_SSL_REJECT_UNAUTHORIZED=false` to your Railway env vars.

**Paperclip starts but agents can't connect**
→ Make sure `PAPERCLIP_DEPLOYMENT_EXPOSURE=public` is set so the server accepts external connections.

## What took the fleet down on 26 August 2026

All 18 agents failed every heartbeat after exactly one second, from 26 to 30
August, with:

```
Claude exited with code 1: error: failed switching to "node": operation not permitted
```

**That message is gosu's, not Claude's.** gosu formats its fatal error as
`failed switching to %q: %v`. If you ever see it again, look for a privilege
drop, not for Claude.

The privilege drop lived in `/paperclip/bin/claude-as-node`. Every agent's
adapter Command field points at that path, so it runs on every heartbeat, but
it existed only on the Railway volume. It was never committed. That is why four
days of reading `git log` found nothing: the broken file was not in the repo.

It failed for two independent reasons:

- It ended with `exec gosu node ...`. Paperclip runs as `paperclip`, uid 999.
  A non-root process cannot setuid, so this returned EPERM every time.
- It bootstrapped its binary with `cp /root/.local/bin/claude`, a hand-installed
  copy in root's home that uid 999 could not read and that no longer existed.

**Pinning `@anthropic-ai/claude-code` did not fix it, and could not have.** The
pin governs `/app/node_modules`, but the shim executed a binary from root's
home instead. An earlier version of this file blamed a rebuild resolving
`latest` to 2.1.247 and a change in how the CLI drops privileges. That was a
guess, and it was wrong. The pin was live and active while the failures
continued.

The wrapper now lives at `scripts/claude-as-node`, is installed into
`/paperclip/bin/` by `start.mjs` on every boot, runs no privilege switch, and
executes `/app/node_modules/.bin/claude`.

## Why the CLI versions are pinned

`@anthropic-ai/claude-code`, `@openai/codex` and `paperclipai` are all pinned,
and `package-lock.json` is committed.

npm resolves ranges when the image is **built**, not when it runs. So a
container can sit on one version for weeks and then jump many versions the next
time anything triggers a rebuild, with no code change and no warning. Pinning
the direct dependencies alone does not close this, because every transitive
dependency still floats. The lockfile plus `npm ci` is what actually closes it.

2.1.229 and codex 0.151.0 are the versions proven to work in this container.
Before changing either, deploy to a copy and confirm an agent heartbeat
completes, rather than assuming a newer release is compatible.

Because the wrapper now runs the binary out of `node_modules`, the pin in
`package.json` is finally the thing that executes. Verify with
`/paperclip/bin/claude-as-node --version` inside the container.
