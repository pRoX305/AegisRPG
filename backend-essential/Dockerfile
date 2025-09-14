# Production Dockerfile for Last Aegis Backend
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Environment variables will be set via Cloud Run configuration

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S lastaegis -u 1001

# Change ownership of the app directory
RUN chown -R lastaegis:nodejs /app
USER lastaegis

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Start the application
CMD ["npm", "start"]
