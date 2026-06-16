FROM mcr.microsoft.com/playwright:v1.58.2-noble AS playwright_browsers

FROM docker:28-cli AS docker_cli

FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive
ENV UV_LINK_MODE=copy
ENV CODEX_HOME=/home/vscode/.codex
ENV NPM_CONFIG_CACHE=/home/vscode/.npm
ENV UV_INSTALL_DIR=/usr/local/bin
ENV PATH=/home/vscode/.local/bin:${PATH}
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker-real
COPY --from=docker_cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY --from=playwright_browsers /ms-playwright/ /ms-playwright/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fonts-liberation \
        git \
        gh \
        graphviz \
        jq \
        libasound2t64 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libatspi2.0-0t64 \
        libcairo2 \
        libcups2t64 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0t64 \
        libgtk-3-0t64 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        make \
        npm \
        openssh-client \
        python3 \
        python3-pip \
        python3-venv \
        sudo \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN npm install -g @mermaid-js/mermaid-cli @openai/codex

RUN printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' '' 'if [ "$(id -u)" -eq 0 ]; then' '  exec /usr/local/bin/docker-real "$@"' 'fi' '' 'exec sudo -n /usr/local/bin/docker-real "$@"' > /usr/local/bin/docker \
    && chmod 0755 /usr/local/bin/docker \
    && printf '%s\n' 'vscode ALL=(root) NOPASSWD: /usr/local/bin/docker-real' > /etc/sudoers.d/vscode-docker \
    && chmod 0440 /etc/sudoers.d/vscode-docker

RUN mkdir -p /home/vscode/.codex /home/vscode/.npm /mnt/host-codex /workspace \
    && chown -R vscode:vscode /home/vscode /mnt/host-codex /workspace /ms-playwright

USER vscode
WORKDIR /workspace
