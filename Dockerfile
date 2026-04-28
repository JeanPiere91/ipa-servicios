# Imagen oficial de Microsoft con Playwright + Chromium ya instalados.
# Versión debe coincidir con la de package.json.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Copiar manifiestos primero para cachear la instalación de dependencias.
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el resto de la app.
COPY . .

# Render asigna el puerto a la variable PORT; el server ya lo lee.
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
