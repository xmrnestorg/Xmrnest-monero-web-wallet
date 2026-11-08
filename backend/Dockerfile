FROM node:20-alpine

WORKDIR /app

COPY . .

ENV PORT=8080
ENV NODE_ENV=production
ENV DOCKER_ENV=true

EXPOSE 8080

# Unprivileged runtime user (the code is mounted read-only; nothing is written under /app).
USER node

CMD ["node", "server.js"]
