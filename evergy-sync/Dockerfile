ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21
FROM $BUILD_FROM
RUN apk add --no-cache nodejs
WORKDIR /app
COPY app/ /app/
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
