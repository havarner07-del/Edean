FROM node:22-bookworm-slim

# Toolchains for the Compiler tab. Remove any you don't need to shrink the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      default-jdk-headless \
      gcc g++ libc6-dev \
      golang-go \
      rustc \
      ruby \
      php-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js runner.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server.js"]
