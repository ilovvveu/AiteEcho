FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ARG APP_GIT_COMMIT=""
ARG APP_BUILD_REF=""
ENV NODE_ENV=production
ENV APP_GIT_COMMIT=$APP_GIT_COMMIT
ENV APP_BUILD_REF=$APP_BUILD_REF
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY scripts/requirements-documents.txt ./scripts/
RUN apk add --no-cache python3 py3-pip ffmpeg \
    && python3 -m venv /opt/aite-echo-python \
    && /opt/aite-echo-python/bin/pip install --no-cache-dir -r scripts/requirements-documents.txt
ENV ACP_DOCUMENT_PYTHON_COMMAND=/opt/aite-echo-python/bin/python3
ENV BOT_VOICE_FFMPEG_COMMAND=ffmpeg
RUN mkdir -p /app/data /app/examples
COPY --from=build /app/dist ./dist
COPY scripts/read-document.py scripts/vision-ocr.swift ./scripts/
COPY examples/group-rules.example.json ./examples/group-rules.example.json
COPY examples/styles ./examples/styles
COPY examples/reply-rules.json ./examples/reply-rules.json
COPY docs ./docs
COPY assets/reverix-banner.png ./assets/reverix-banner.png
COPY .env.example README.md ARCHITECTURE.md LICENSE NOTICE DISCLAIMER.md ./
RUN chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
