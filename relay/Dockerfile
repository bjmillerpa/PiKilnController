FROM node:20-alpine

WORKDIR /app

# Install deps first for layer cache
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY relay-server.js ./
COPY lib/ ./lib/

# Web bundle is bind-mounted at /app/web by docker-compose
ENV WEB_DIR=/app/web
ENV PORT=8080

USER node
EXPOSE 8080

CMD ["node", "relay-server.js"]
