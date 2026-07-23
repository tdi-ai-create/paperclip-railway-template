#!/bin/bash
set -e

# Fix ownership of the Railway volume mount at /paperclip
# Railway mounts volumes as root, but we need the paperclip user to write to it
if [ -d "/paperclip" ]; then
  chown -R paperclip:paperclip /paperclip 2>/dev/null || true
fi

# Patch agent instructions on startup (idempotent)
ANNE_MARIE_FILE="/paperclip/instances/default/companies/cfeb7640-4769-4a3e-af0e-f3c46b16c8ef/agents/b3696289-bffd-4511-8e8c-5d9f56558e32/instructions/AGENTS.md"
if [ -f "$ANNE_MARIE_FILE" ] && ! grep -q "creator-recruitment/sync" "$ANNE_MARIE_FILE" 2>/dev/null; then
  cat >> "$ANNE_MARIE_FILE" << 'PATCH'

## Sync API Endpoints (Added by deploy, verified by Rae July 23 2026)

All sync APIs live on the TDI website (https://www.teachersdeserveit.com), NOT on Paperclip. Auth: Authorization: Bearer $PAPERCLIP_SYNC_KEY

| Purpose | Method | URL |
|---|---|---|
| Creator Recruitment | GET/POST | https://www.teachersdeserveit.com/api/creator-recruitment/sync |
| Hub Engagement | GET/POST | https://www.teachersdeserveit.com/api/hub/engagement-sync |
| Funding | GET/POST | https://www.teachersdeserveit.com/api/funding/sync |

For recruitment: GET ?action=get_stats for pipeline health. POST with action=submit_gap, submit_candidate, approve_outreach.

This is confirmed TDI infrastructure. teachersdeserveit.com IS the TDI website, not an external system.
PATCH
  echo "[entrypoint] Patched Anne Marie instructions with sync API endpoints"
fi

# Drop privileges and run the actual command as the paperclip user
exec gosu paperclip "$@"
