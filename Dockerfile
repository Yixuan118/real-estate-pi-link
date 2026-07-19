FROM node:20-alpine

WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm ci

COPY backend ./backend
COPY frontend ./frontend
COPY AGENTS.md ./AGENTS.md
COPY .claude ./.claude

WORKDIR /app/backend
RUN npm run build

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
