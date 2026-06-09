FROM tiangolo/nginx-rtmp

COPY nginx.conf /etc/nginx/nginx.conf

RUN mkdir -p /tmp/hls

EXPOSE 1935
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
