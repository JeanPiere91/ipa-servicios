# Imagen liviana de Node sin Playwright (ya no es necesario).
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
