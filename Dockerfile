FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY initiative-advisor.html ./

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
