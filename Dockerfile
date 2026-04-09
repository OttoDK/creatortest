FROM node:20

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY initiative-advisor.html ./

ENV NODE_ENV=production

CMD ["node", "server.js"]
