FROM node:22-bookworm-slim

# Debian owns the desktop/browser updates; Playwright supplies only the CDP client, not another browser.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium xvfb openbox x11vnc novnc websockify \
       xterm iptables ca-certificates bash coreutils \
    && rm -rf /var/lib/apt/lists/* \
    && userdel node \
    && useradd --uid 1000 --create-home --shell /bin/bash vivid \
    && mkdir -p /opt/vivid /home/vivid/.config/chromium \
    && chown -R vivid:vivid /home/vivid

WORKDIR /opt/vivid
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Keep package-manager policy consistent even in the independent Computer image.
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate \
    && pnpm add --save-exact playwright-core@1.62.1 effect@4.0.0-rc.116
COPY browser.mjs cli.mjs shutdown.mjs entrypoint egress /opt/vivid/
RUN chmod 0555 /opt/vivid/entrypoint /opt/vivid/egress

ENV HOME=/home/vivid LANG=C.UTF-8 DISPLAY=:99
USER 1000:1000
WORKDIR /home/vivid
VOLUME ["/home/vivid"]
EXPOSE 6080
ENTRYPOINT ["/opt/vivid/entrypoint"]
