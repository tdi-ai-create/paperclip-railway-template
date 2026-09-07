#!/bin/bash
set -e

# Fix ownership of the Railway volume mount at /paperclip
# Railway mounts volumes as root, but we need the paperclip user to write to it
if [ -d "/paperclip" ]; then
  chown -R paperclip:paperclip /paperclip 2>/dev/null || true
fi

# ── Layer 1: Write env file that agents can source ──
# This used to hardcode the sync key. That gave the same variable two sources
# with two different values: Paperclip injects the bound secret into the agent,
# and then any wrapper script sourcing this file overwrote it with the literal
# below. When the Paperclip secret was rotated on 1 September the two stopped
# matching, so a call made through a wrapper succeeded and the identical call
# made directly returned 401. That is the flapping recorded on TEA-266 and
# TEA-270, which read as an outage that kept fixing and unfixing itself.
#
# The key now has exactly one source: the secret Paperclip binds as
# TDI_SYNC_KEY. This file only fills it in if it is somehow absent, and never
# overrides a value that is already there.
cat > /paperclip/.sync-env << 'ENVFILE'
export TDI_SYNC_KEY="${TDI_SYNC_KEY:-$PAPERCLIP_SYNC_KEY}"
export TDI_API_BASE="https://www.teachersdeserveit.com"
ENVFILE
chmod 644 /paperclip/.sync-env

# ── Layer 2: Create wrapper scripts that agents can call directly ──
# These remove all ambiguity. Agents just run: /paperclip/bin/tdi-create-draft "title" "desc" "category"

mkdir -p /paperclip/bin

# Create draft Quick Win
cat > /paperclip/bin/tdi-create-draft << 'SCRIPT'
#!/bin/bash
# Usage: tdi-create-draft "Title" "slug" "Description" "category" '["tag1","tag2"]' '["teacher","para"]' '["3-instruction"]' "LOW" "essentials"
source /paperclip/.sync-env
TITLE="$1"
SLUG="$2"
DESC="$3"
CATEGORY="${4:-Classroom Tools}"
TAGS="${5:-[\"classroom-management\"]}"
ROLES="${6:-[\"teacher\"]}"
DANIELSON="${7:-[\"3-instruction\"]}"
LIFT="${8:-LOW}"
TIER="${9:-professional}"

curl -s -X POST "$TDI_API_BASE/api/hub/content-sync" \
  -H "Authorization: Bearer $TDI_SYNC_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"action\": \"create_draft\",
    \"title\": \"$TITLE\",
    \"slug\": \"$SLUG\",
    \"description\": \"$DESC\",
    \"category\": \"$CATEGORY\",
    \"topic_tags\": $TAGS,
    \"roles\": $ROLES,
    \"danielson_domains\": $DANIELSON,
    \"lift\": \"$LIFT\",
    \"access_tier\": \"$TIER\"
  }"
echo ""
SCRIPT
chmod +x /paperclip/bin/tdi-create-draft

# Upload PDF to a draft
cat > /paperclip/bin/tdi-upload-pdf << 'SCRIPT'
#!/bin/bash
# Usage: tdi-upload-pdf <quick-win-id> <path-to-pdf>
source /paperclip/.sync-env
QW_ID="$1"
PDF_PATH="$2"

if [ ! -f "$PDF_PATH" ]; then
  echo "Error: File not found: $PDF_PATH"
  exit 1
fi

FILENAME=$(basename "$PDF_PATH")
PDF_B64=$(base64 -w0 "$PDF_PATH" 2>/dev/null || base64 "$PDF_PATH")

curl -s -X POST "$TDI_API_BASE/api/hub/content-sync" \
  -H "Authorization: Bearer $TDI_SYNC_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"action\": \"upload_pdf\",
    \"id\": \"$QW_ID\",
    \"pdf_base64\": \"$PDF_B64\",
    \"filename\": \"$FILENAME\"
  }"
echo ""
SCRIPT
chmod +x /paperclip/bin/tdi-upload-pdf

# Seed community post
cat > /paperclip/bin/tdi-seed-community << 'SCRIPT'
#!/bin/bash
# Usage: tdi-seed-community <quick-win-id> <user-id> <type> "body text"
# Types: tried_it, adapted_it, still_trying, got_stuck, didnt_land
# Users: teacher=c3c1c7a9-e084-47b8-9945-15423f154ca9 para=7a502d0a-29e9-4490-b330-ea1131311d44
#        coach=4236f26b-88a7-4ae9-abf6-65cd09e9fdd9 para2=d532b342-5aff-420d-8201-ae1d6564650c
#        teacher2=63e924ff-dfc6-4f24-9da2-950dae9b65d9
source /paperclip/.sync-env
QW_ID="$1"
USER_ID="$2"
TYPE="$3"
BODY="$4"

curl -s -X POST "$TDI_API_BASE/api/hub/community/seed" \
  -H "Authorization: Bearer $TDI_SYNC_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"quick_win_id\": \"$QW_ID\",
    \"user_id\": \"$USER_ID\",
    \"contribution_type\": \"$TYPE\",
    \"body\": \"$BODY\"
  }"
echo ""
SCRIPT
chmod +x /paperclip/bin/tdi-seed-community

# Check pipeline status
cat > /paperclip/bin/tdi-status << 'SCRIPT'
#!/bin/bash
# Usage: tdi-status
source /paperclip/.sync-env
echo "=== Hub Content Pipeline Status ==="
curl -s "$TDI_API_BASE/api/hub/content-sync?action=get_status" \
  -H "Authorization: Bearer $TDI_SYNC_KEY" | python3 -m json.tool 2>/dev/null || cat
echo ""
echo "=== Drafts Needing Work ==="
curl -s "$TDI_API_BASE/api/hub/content-sync?action=list_drafts" \
  -H "Authorization: Bearer $TDI_SYNC_KEY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for draft in d.get('drafts',[]):
    flags = []
    if not draft.get('has_pdf'): flags.append('NEEDS PDF')
    if not draft.get('has_description'): flags.append('NEEDS DESC')
    if not draft.get('has_tags'): flags.append('NEEDS TAGS')
    print(f'  {draft[\"title\"]} [{\" | \".join(flags) if flags else \"READY\"}]')
" 2>/dev/null || cat
SCRIPT
chmod +x /paperclip/bin/tdi-status

# Add bin to PATH for all agent sessions
echo 'export PATH="/paperclip/bin:$PATH"' >> /paperclip/.bashrc 2>/dev/null || true

echo "[entrypoint] Created /paperclip/bin/ sync tools and .sync-env"

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
