# Build from the repo root so the Snack Station page is included:
#   docker build -f family-hub/Dockerfile -t family-hub .
FROM node:22-alpine
WORKDIR /app/family-hub
COPY family-hub/package*.json ./
RUN npm ci --omit=dev
COPY family-hub/ ./
COPY index.html /app/index.html
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
