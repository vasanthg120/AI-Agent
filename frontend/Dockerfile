# React (Vite) frontend: built once, served as static files by Nginx.
# Vite bakes the API and socket addresses into the bundle at build time, so they
# are build arguments — CI passes the production values (see .github/workflows/deploy.yml).
FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:3000
ARG VITE_SOCKET_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL \
    VITE_SOCKET_URL=$VITE_SOCKET_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
