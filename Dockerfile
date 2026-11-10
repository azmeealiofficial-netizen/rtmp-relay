FROM tiangolo/nginx-rtmp

# Install Node.js
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy nginx config (same as working rtmp-relay)
COPY nginx.conf /etc/nginx/nginx.conf

# MediaMTX — SRT in/out alongside nginx-rtmp (see mediamtx.yml)
ARG MEDIAMTX_VERSION=v1.21.3
RUN curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz" \
      | tar xz -C /usr/local/bin mediamtx && \
    /usr/local/bin/mediamtx --version
COPY mediamtx.yml /etc/mediamtx.yml

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
EXPOSE 8890/udp

# Start both nginx and node
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
