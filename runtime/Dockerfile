FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    file \
    findutils \
    git \
    grep \
    python3 \
    procps \
    sed \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace \
  && chown -R node:node /workspace

USER node
WORKDIR /workspace

CMD ["/bin/bash", "-lc", "sleep infinity"]
