FROM node:22-alpine

WORKDIR /app
ENV PORT=4000 \
    DEMO_SHOP_TEST_ENDPOINTS=1

COPY package.json ./
COPY src ./src

USER node
EXPOSE 4000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/healthz || exit 1

CMD ["node", "src/server.js"]
