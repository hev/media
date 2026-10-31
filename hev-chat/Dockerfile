FROM node:24-alpine AS build
WORKDIR /app
COPY packages/sdk /packages/sdk
RUN cd /packages/sdk && npm install --ignore-scripts && npm run build
COPY hev-chat/package*.json ./
RUN npm ci --ignore-scripts
COPY hev-chat/tsconfig.json ./
COPY hev-chat/src ./src
RUN npm run build && npm prune --omit=dev
FROM node:24-alpine
ENV NODE_ENV=production PORT=2290
WORKDIR /app
COPY --from=build /packages/sdk /packages/sdk
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
ENV HEV_CHAT_DATA=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 2290
CMD ["node", "build/server.js"]
