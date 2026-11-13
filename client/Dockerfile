# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY app ./app
COPY assets ./assets
COPY plugins ./plugins
COPY public ./public
COPY src ./src
COPY app.json babel.config.js metro.config.js tsconfig.json index.html ./
COPY google-services.json GoogleService-Info.plist ./
RUN npm run build

FROM nginx:alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
