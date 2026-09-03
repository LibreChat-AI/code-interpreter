FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
RUN apk add --no-cache ripgrep \
  && addgroup -S librechat-code \
  && adduser -S librechat-code -G librechat-code
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER librechat-code
ENTRYPOINT ["node", "dist/cli.js"]
