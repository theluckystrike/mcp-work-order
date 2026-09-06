# Build context: repository root (monorepo with npm workspaces).
# docker buildx build -f servers/work-order/Dockerfile .
#
# The siblings below are copied and built too, because this server is assembled from them:
# mcp-invoice supplies the money and VAT arithmetic (computeTotals, currencyDecimals,
# formatMoney, roundHalfUp) and the client records a job is raised against, mcp-billing-docs
# the A4 renderer used for the completion report, mcp-quotes the timezone-aware "today",
# mcp-timezone the corrupt-store quarantine. Nothing is fetched over the network.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY servers ./servers
RUN npm install --no-audit --no-fund \
 && npm run build --workspace @theluckystrike/mcp-timezone \
 && npm run build --workspace @theluckystrike/mcp-license \
 && npm run build --workspace @theluckystrike/mcp-invoice \
 && npm run build --workspace @theluckystrike/mcp-quotes \
 && npm run build --workspace @theluckystrike/mcp-billing-docs \
 && npm run build --workspace @theluckystrike/mcp-work-order

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/servers/timezone/package.json ./servers/timezone/package.json
COPY --from=build /app/servers/timezone/dist ./servers/timezone/dist
COPY --from=build /app/packages/mcp-license/package.json ./packages/mcp-license/package.json
COPY --from=build /app/packages/mcp-license/dist ./packages/mcp-license/dist
COPY --from=build /app/servers/invoice/package.json ./servers/invoice/package.json
COPY --from=build /app/servers/invoice/dist ./servers/invoice/dist
COPY --from=build /app/servers/quotes/package.json ./servers/quotes/package.json
COPY --from=build /app/servers/quotes/dist ./servers/quotes/dist
COPY --from=build /app/servers/billing-docs/package.json ./servers/billing-docs/package.json
COPY --from=build /app/servers/billing-docs/dist ./servers/billing-docs/dist
COPY --from=build /app/servers/work-order/package.json ./servers/work-order/package.json
COPY --from=build /app/servers/work-order/dist ./servers/work-order/dist
RUN npm install --omit=dev --no-audit --no-fund --workspace @theluckystrike/mcp-work-order --include-workspace-root=false
CMD ["node", "servers/work-order/dist/index.js"]
