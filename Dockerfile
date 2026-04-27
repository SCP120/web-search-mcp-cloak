FROM node:22-slim

# Chromium runtime libraries (cloakbrowser brings its own chromium binary,
# but it still needs the system libs to run).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libexpat1 \
        libgbm1 \
        libglib2.0-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libudev1 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Pre-download cloakbrowser's stealth chromium for linux-arm64/x64.
# Bakes the binary into the image so cold starts don't pay the download.
RUN npx cloakbrowser install && npx cloakbrowser info

# Copy the built MCP server
COPY dist ./dist

# stdio MCP — no port to expose. --init wraps PID 1 as a proper signal/zombie reaper.
ENTRYPOINT ["node", "dist/index.js"]
