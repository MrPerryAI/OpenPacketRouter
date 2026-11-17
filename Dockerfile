FROM node:20-alpine
WORKDIR /app
COPY server/server.js server/server.js
COPY web/index.html web/index.html
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 DATA_DIR=/data
USER node
EXPOSE 8080
VOLUME /data
CMD ["node", "server/server.js"]
