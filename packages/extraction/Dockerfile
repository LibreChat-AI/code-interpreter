FROM node:24.16.0-bookworm-slim AS build
WORKDIR /build
COPY packages/extraction/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/extraction/tsconfig.json ./
COPY packages/extraction/src ./src
RUN npm run build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev && rm -rf /var/lib/apt/lists/*
COPY packages/extraction/native/guard.c ./guard.c
RUN gcc -O2 -Wall -Wextra -Werror -o guard guard.c
COPY packages/extraction/tests/block-landlock.c ./block-landlock.c
RUN gcc -O2 -Wall -Wextra -Werror -o block-landlock block-landlock.c

FROM python:3.13-slim-bookworm@sha256:5024f48ba9441d4b13a95d3945abc6365538e3a31109833367a1923523c6efed AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/*
COPY packages/extraction/worker/requirements.txt /opt/extraction/requirements.txt
RUN pip install --no-cache-dir -r /opt/extraction/requirements.txt
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chmod=0555 /build/guard /opt/extraction/guard
COPY --from=build --chmod=0555 /build/dist /opt/extraction/dist
COPY --chmod=0444 packages/extraction/package.json /opt/extraction/package.json
COPY --chmod=0444 packages/extraction/worker/extract.py /opt/extraction/extract.py
RUN groupadd -g 10001 extraction && useradd -u 10001 -g extraction -M extraction && \
    mkdir /socket /jobs && chown extraction:extraction /socket /jobs && chmod 0700 /jobs && chmod 0770 /socket
USER 10001:10001
WORKDIR /opt/extraction
HEALTHCHECK --interval=10s --timeout=2s --start-period=10s --retries=3 CMD ["node", "dist/health.js"]
CMD ["node", "dist/main.js"]

FROM runtime AS qualification
COPY --chown=10001:10001 packages/extraction/tests /tests
COPY --from=build --chmod=0555 /build/block-landlock /tests/block-landlock
