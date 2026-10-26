FROM node:24-alpine

WORKDIR /app
RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "start"]
