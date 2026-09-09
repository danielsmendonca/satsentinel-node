# Repo autocontido: contexto = esta pasta (satsentinel-node).
# Build: docker build -t satsentinel-node .
# O protocolo mora em ./protocol (fonte da verdade, consumido via file:./protocol).
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY protocol ./protocol
RUN npm install --no-audit --no-fund
COPY src ./src
COPY test ./test
COPY tsconfig.json ./
RUN npm run build
CMD ["node", "dist/src/runner.js"]
