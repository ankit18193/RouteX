# ==============================================================================
# RouteX Production Multi-Stage Dockerfile
# Optimized for minimal footprint, security, and fast layer caching
# ==============================================================================

# --- Stage 1: Build Stage ---
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency specifications
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

# Copy source code and mock services
COPY src/ ./src/
COPY mock-services/ ./mock-services/

# Compile TypeScript to JavaScript in /app/dist
RUN npm run build

# --- Stage 2: Production Stage ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Copy configuration files and directories
COPY config/ ./config/

# Ensure non-root user execution
RUN chown -R node:node /app
USER node

# Expose default Gateway HTTP port
EXPOSE 8080

# Health check against gateway liveness endpoint
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/livez || exit 1

# Start RouteX API Gateway
CMD ["npm", "start"]
