# syntax=docker/dockerfile:1.7
#
# Single-image deliverable: builds the Nuxt app on Node, then layers a
# checksum-verified Node runtime + nuclei + nuclei-templates onto the
# official ZAP image so nuclei, ZAP and the app share one container.
#
# Versions verified before pinning (see task-15-report.md for how):
#   - ZAP_VERSION: ghcr.io/zaproxy/zaproxy:2.17.0 (manifest confirmed)
#   - ZAP_IMAGE_DIGEST: the 2.17.0 multi-arch index as rebuilt upstream on 2026-11-03 (Debian 12.15
#     with perl 5.36.0-7+deb12u4, firefox-esr 153.6.0esr, certifi 2026.10.23, urllib3 2.8.0 — #63, #65).
#     The tag is rebuilt in place, so the digest pins which build every machine uses; bump both together.
#   - NODE_VERSION: 22.23.4 (latest Node 22 "Jod" LTS, security release, nodejs.org/dist/index.json)
#   - NUCLEI_VERSION: 3.11.1 (github.com/projectdiscovery/nuclei latest release)
#   - NUCLEI_TEMPLATES_TAG: v10.5.1 (github.com/projectdiscovery/nuclei-templates latest release)
#   - KATANA_VERSION: 1.7.0 (1.8.0 is out, but its release binary is built with Go 1.26.0 — older than
#     1.7.0's Go 1.26.5 — and re-adds stdlib advisories; held until a patched build, see #61)
#   - DALFOX_VERSION: 3.3.0 (github.com/hahwul/dalfox latest release)
#   - HTTPX_VERSION: 1.12.0 (github.com/projectdiscovery/httpx latest release; ≥1.12 runs its
#     page-type classifier — and downloads its model — only with `-kb`, which sakuda never passes)
#   - ASCANRULES_BETA_VERSION: 67 (zap-extensions ascanrulesBeta-v67, requires ZAP>=2.17.0 and
#     commonlib>=1.43.0 — the ZAP 2.17.0 image bundles commonlib 1.43.0)
ARG ZAP_VERSION=2.17.0
ARG ZAP_IMAGE_DIGEST=sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af
ARG NODE_VERSION=22.23.4
ARG NUCLEI_VERSION=3.11.1
ARG NUCLEI_TEMPLATES_TAG=v10.5.1
ARG KATANA_VERSION=1.7.0
ARG DALFOX_VERSION=3.3.0
ARG HTTPX_VERSION=1.12.0
ARG ASCANRULES_BETA_VERSION=67

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 ships a binding.gyp, which pnpm auto-builds via node-gyp on
# install regardless of any bundled prebuild; node:*-slim has no toolchain.
# Built for the build stage's own arch (linux/arm64 or linux/amd64) here —
# never copied in from the macOS host.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM ghcr.io/zaproxy/zaproxy:${ZAP_VERSION}@${ZAP_IMAGE_DIGEST}
ARG ZAP_VERSION NODE_VERSION NUCLEI_VERSION NUCLEI_TEMPLATES_TAG KATANA_VERSION DALFOX_VERSION HTTPX_VERSION ASCANRULES_BETA_VERSION TARGETARCH
USER root

# ZAP's Debian base already ships curl, unzip and git; if that ever changes,
# install them here (apt-get, --no-install-recommends, cleaned lists).

# Node (official tarball, checksum-verified; TARGETARCH amd64->x64)
RUN set -eux; arch="$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64)"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " node-v${NODE_VERSION}-linux-${arch}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-${arch}.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f node-v* SHASUMS256.txt; node --version

# nuclei (checksum-verified) + pinned templates
RUN set -eux; \
    curl -fsSLO "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_${TARGETARCH}.zip"; \
    curl -fsSLO "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_checksums.txt"; \
    grep "nuclei_${NUCLEI_VERSION}_linux_${TARGETARCH}.zip" "nuclei_${NUCLEI_VERSION}_checksums.txt" | sha256sum -c -; \
    unzip -o "nuclei_${NUCLEI_VERSION}_linux_${TARGETARCH}.zip" nuclei -d /usr/local/bin; chmod 755 /usr/local/bin/nuclei; rm -f nuclei_*; \
    git clone --depth 1 --branch "${NUCLEI_TEMPLATES_TAG}" https://github.com/projectdiscovery/nuclei-templates /opt/nuclei-templates; \
    rm -rf /opt/nuclei-templates/.git

# katana (checksum-verified; static crawl only, no headless browser). Note the
# checksums asset is `katana-<ver>-checksums.txt` (hyphens), unlike nuclei's.
RUN set -eux; \
    curl -fsSLO "https://github.com/projectdiscovery/katana/releases/download/v${KATANA_VERSION}/katana_${KATANA_VERSION}_linux_${TARGETARCH}.zip"; \
    curl -fsSLO "https://github.com/projectdiscovery/katana/releases/download/v${KATANA_VERSION}/katana-${KATANA_VERSION}-checksums.txt"; \
    grep "katana_${KATANA_VERSION}_linux_${TARGETARCH}.zip" "katana-${KATANA_VERSION}-checksums.txt" | sha256sum -c -; \
    unzip -o "katana_${KATANA_VERSION}_linux_${TARGETARCH}.zip" katana -d /usr/local/bin; chmod 755 /usr/local/bin/katana; rm -f katana_* katana-*

# dalfox (checksum-verified; the reflected/DOM XSS engine). Rust build,
# glibc tarball (not -musl) to match the Debian ZAP base. TARGETARCH
# amd64->x86_64, arm64->aarch64; the binary sits one dir deep in the tar.
RUN set -eux; arch="$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64)"; \
    f="dalfox-v${DALFOX_VERSION}-linux-${arch}.tar.gz"; \
    curl -fsSLO "https://github.com/hahwul/dalfox/releases/download/v${DALFOX_VERSION}/${f}"; \
    curl -fsSLO "https://github.com/hahwul/dalfox/releases/download/v${DALFOX_VERSION}/${f}.sha256"; \
    sha256sum -c "${f}.sha256"; \
    tar -xzf "${f}" --strip-components=1 -C /usr/local/bin "dalfox-v${DALFOX_VERSION}-linux-${arch}/dalfox"; \
    chmod 755 /usr/local/bin/dalfox; rm -f dalfox-*

# httpx (checksum-verified; nuclei's pre-scan liveness probe, #91). Same asset
# naming as nuclei's (`httpx_<ver>_checksums.txt`).
RUN set -eux; \
    curl -fsSLO "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_linux_${TARGETARCH}.zip"; \
    curl -fsSLO "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_checksums.txt"; \
    grep "httpx_${HTTPX_VERSION}_linux_${TARGETARCH}.zip" "httpx_${HTTPX_VERSION}_checksums.txt" | sha256sum -c -; \
    unzip -o "httpx_${HTTPX_VERSION}_linux_${TARGETARCH}.zip" httpx -d /usr/local/bin; chmod 755 /usr/local/bin/httpx; rm -f httpx_*

# ZAP ascanrulesBeta add-on (NoSQL(MongoDB)/LDAP injection active scan rules).
# Pinned by version + SHA-256 and dropped into /zap/plugin/ so ZAP loads it at
# startup without any runtime marketplace fetch (offline / reproducible, per
# ADR-0002). ZAP add-on releases ship no checksums file, so the hash is pinned
# here the same way the Node tarball's is.
ARG ASCANRULES_BETA_SHA256=81e84d592b1f7ad803470bcc8d8b659d4f7e21370546a482b606207e57a7db69
RUN set -eux; \
    # ascanrulesBeta-v67 requires ZAP >= 2.17.0; fail the build fast if
    # ZAP_VERSION was overridden to an older base rather than shipping an image
    # whose ZAP cannot load the add-on.
    dpkg --compare-versions "${ZAP_VERSION}" ge "2.17.0"; \
    zap="ascanrulesBeta-beta-${ASCANRULES_BETA_VERSION}.zap"; \
    curl -fsSLO "https://github.com/zaproxy/zap-extensions/releases/download/ascanrulesBeta-v${ASCANRULES_BETA_VERSION}/${zap}"; \
    echo "${ASCANRULES_BETA_SHA256}  ${zap}" | sha256sum -c -; \
    # Drop any other ascanrulesBeta the base image might carry so the pinned
    # version is the only one ZAP can load (reproducibility).
    rm -f /zap/plugin/ascanrulesBeta-*.zap; \
    install -o zap -g zap -m 644 "${zap}" "/zap/plugin/${zap}"; \
    rm -f "${zap}"; \
    ls -1 "/zap/plugin/${zap}"

WORKDIR /app
COPY --from=build --chown=zap:zap /app/.output ./.output
COPY --chown=zap:zap server/db/migrations ./migrations
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/sakuda-entrypoint
RUN mkdir -p /data && chown zap:zap /data /app
USER zap
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 HOME=/home/zap \
    SAKUDA_DATA_DIR=/data SAKUDA_MIGRATIONS_DIR=/app/migrations \
    SAKUDA_NUCLEI_BIN=/usr/local/bin/nuclei SAKUDA_NUCLEI_TEMPLATES=/opt/nuclei-templates/http \
    SAKUDA_NUCLEI_DAST_TEMPLATES=/opt/nuclei-templates/dast \
    SAKUDA_KATANA_BIN=/usr/local/bin/katana SAKUDA_DALFOX_BIN=/usr/local/bin/dalfox \
    SAKUDA_HTTPX_BIN=/usr/local/bin/httpx \
    SAKUDA_ZAP_CMD=/zap/zap.sh SAKUDA_LOCALHOST_ALIAS=host.docker.internal
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["sakuda-entrypoint"]
