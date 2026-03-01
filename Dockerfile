FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install deps
RUN npm ci --omit=dev

# Copy source
COPY . .

# Build TypeScript
RUN npx tsc

# Expose gateway port
EXPOSE 18790

# Memory and sessions persist in /app/memory
VOLUME /app/memory

# Start Alice
CMD ["node", "dist/index.js", "start"]
