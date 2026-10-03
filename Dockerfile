FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts/encrypt-kyc-fields.js ./scripts/encrypt-kyc-fields.js
EXPOSE 3003
CMD ["sh", "-c", "node scripts/encrypt-kyc-fields.js && node dist/main"]
