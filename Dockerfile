FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

# poppler-utils rasterises pages; python3 runs the recognition daemon. No OCR
# engine is installed system-wide: recognition is PaddleOCR PP-OCRv5 on ONNX
# Runtime, which reads these documents both faster and far more accurately.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl poppler-utils python3 python3-venv libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# The Python runtime lives in its own virtualenv so it cannot collide with the
# system interpreter Debian's own tooling uses.
ENV VIRTUAL_ENV=/opt/ocr-venv
ENV PYTHON_BIN=$VIRTUAL_ENV/bin/python
COPY python/requirements.txt ./python/requirements.txt
RUN python3 -m venv $VIRTUAL_ENV \
    && $VIRTUAL_ENV/bin/pip install --no-cache-dir --upgrade pip \
    && $VIRTUAL_ENV/bin/pip install --no-cache-dir -r python/requirements.txt

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY python ./python
COPY --from=build /app/dist ./dist

# The official PaddleOCR PP-OCRv5 models: mobile text detection, the 180-degree
# orientation classifier, and the Latin recognition model, which covers both
# English and Azerbaijani. Roughly 13 MB in total, baked into the image so a
# cold worker starts recognising without reaching the network, and so no page
# ever leaves this container.
ENV PPOCR_MODEL_DIR=/app/models
RUN mkdir -p storage tmp \
    && $VIRTUAL_ENV/bin/python python/download_models.py $PPOCR_MODEL_DIR

# Fails the build rather than the first upload if a model is unreadable.
RUN $VIRTUAL_ENV/bin/python -c "\
import onnxruntime as ort, os; d=os.environ['PPOCR_MODEL_DIR']; \
[ort.InferenceSession(os.path.join(d,n), providers=['CPUExecutionProvider']) for n in ('det.onnx','cls.onnx','rec_latin.onnx')]; \
print('PaddleOCR models load correctly')"

EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
