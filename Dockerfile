# Runs the Worker on Node (see server/node.mjs) for hosts without Cloudflare.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 KV_PATH=/data/kv.json
COPY package.json ./
COPY src ./src
COPY public ./public
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "server/node.mjs"]
