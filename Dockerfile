FROM tiangolo/nginx-rtmp

# Install Node.js
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy nginx config (same as working rtmp-relay)
COPY nginx.conf /etc/nginx/nginx.conf

# Create HLS directory
RUN mkdir -p /tmp/hls

# Create app directory
WORKDIR /app

# Copy node app
COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public ./public

# Expose ports
EXPOSE 1935
EXPOSE 8080

# Start both nginx and node
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
