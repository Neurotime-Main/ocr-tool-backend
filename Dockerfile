FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Official Tesseract models, downloaded during the image build and kept local
# to the running service; no OCR request leaves the server. The native binary
# reads them uncompressed, so unlike the previous WASM engine they are not gzipped.
#
# tessdata_fast is the default because it reads a page roughly twice as fast as
# tessdata_best on the same image while producing near-identical text on the
# scans this tool handles. Build with
# `--build-arg TESSDATA_VARIANT=tessdata_best` to trade that speed back for the
# most accurate models on very poor-quality originals.
#
# osd.traineddata is the orientation model, always taken from tessdata_fast
# because the accuracy variants do not all publish one. Without it Tesseract
# cannot straighten a sideways scan, and the service falls back to the layout
# modes that skip orientation detection.
ARG TESSDATA_VARIANT=tessdata_fast
RUN mkdir -p storage tmp tessdata \
    && curl --fail --location --retry 3 --output tessdata/eng.traineddata "https://github.com/tesseract-ocr/${TESSDATA_VARIANT}/raw/main/eng.traineddata" \
    && curl --fail --location --retry 3 --output tessdata/aze.traineddata "https://github.com/tesseract-ocr/${TESSDATA_VARIANT}/raw/main/aze.traineddata" \
    && curl --fail --location --retry 3 --output tessdata/osd.traineddata "https://github.com/tesseract-ocr/tessdata_fast/raw/main/osd.traineddata"
ENV TESSDATA_PATH=/app/tessdata
ENV TESSDATA_PREFIX=/app/tessdata
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
