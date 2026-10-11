# ---- ai-service: OCR via Datalab and extraction via OpenAI ----
# A thin FastAPI service that forwards documents to external APIs. No local
# model and no GPU are needed.
#
# Secrets are not baked in. At runtime the container reads DATALAB_API_KEY and
# OPENAI_API_KEY from its environment. local.env is excluded by .dockerignore.
FROM python:3.11-slim

WORKDIR /app

# PYTHONUNBUFFERED: log lines flush immediately (so container logs are live).
# PYTHONDONTWRITEBYTECODE: no .pyc clutter in the image layer.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install deps first so this layer caches unless requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application (local.env / .env are excluded via .dockerignore).
COPY . .

# Internal ingress only in production — the backend calls this, the browser never does.
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
