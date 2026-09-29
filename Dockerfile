FROM node:20-slim

# gosu: privilege dropping in entrypoint.
# git: engineering agents cannot build without it. Chris already has Bash, Read
# and Edit, and an empty workspace with no git was the whole reason 44 [BUILD]
# tickets sat queued behind a human. Installed in the image rather than at boot
# because only /paperclip persists; anything apt-installed at runtime is gone on
# the next deploy, the same trap that lost the backups.
# ca-certificates: git alone is not enough. With no CA bundle, cloning over HTTPS
# dies on "server certificate verification failed. CAfile: none", which is exactly
# what happened on the first clone attempt after git landed. node:20-slim ships no
# CA store; Node does not need one because it bundles its own roots, which is why
# nothing noticed until a non-Node tool made an outbound TLS call.
#
# curl: agents already reach for it. Chris ran `curl -s -H ...` on 28 Sep, and when
# that failed he ran `which wget node python3 python`, found only node, and fell
# back to `node -e` one-liners for every HTTP call. Supplying curl removes a
# pointless detour, and it needs the same CA bundle git does.
RUN apt-get update && apt-get install -y --no-install-recommends gosu git ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Create a non-root user (required: Claude CLI refuses --dangerously-skip-permissions as root)
RUN groupadd -r paperclip && useradd -r -g paperclip -m -d /home/paperclip -s /bin/bash paperclip

# Create the paperclip home directory (Railway volume mount point)
RUN mkdir -p /paperclip && chown -R paperclip:paperclip /paperclip

WORKDIR /app

# Copy package files and install dependencies.
#
# npm ci, not npm install, and the lockfile is committed. npm resolves ranges at
# BUILD time, so with a floating dependency a container can sit on one version
# for weeks and then jump many versions on the next rebuild, with no code change
# and no warning. Pinning the four direct dependencies is not enough on its own
# because every transitive dependency still floats.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Give ownership of everything to the non-root user
RUN chown -R paperclip:paperclip /app /home/paperclip

# Copy and set up entrypoint (fixes volume mount ownership at runtime)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Railway injects PORT at runtime (default 3100)
ENV PORT=3100
EXPOSE 3100

# Entrypoint runs as root to fix volume permissions, then drops to paperclip user
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]
