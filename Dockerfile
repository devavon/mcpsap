# ============================================================
#  MCP SAP Business One — imagen Docker (multi-stage)
# ============================================================

# --- Etapa 1: build (compila TypeScript a dist/) ---
FROM node:22-alpine AS build
WORKDIR /app

# Instala TODAS las dependencias (incluidas dev) para poder compilar.
COPY package.json package-lock.json* ./
RUN npm ci

# Copia el código y compila.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Etapa 2: runtime (solo lo necesario para ejecutar) ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Solo dependencias de producción.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Artefactos compilados y configuración no secreta.
COPY --from=build /app/dist ./dist
COPY config ./config

# Carpeta de auditoría con permisos para el usuario no-root.
RUN mkdir -p /app/audit-logs && chown -R node:node /app/audit-logs

# El servidor escucha en PORT (lo inyecta Railway) o 3000 por defecto.
EXPOSE 3000

# Ejecuta como usuario no-root (la imagen node trae el usuario "node").
USER node

CMD ["node", "dist/index.js"]
