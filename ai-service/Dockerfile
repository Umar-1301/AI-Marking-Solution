# ---- ai-service: OCR via Azure AI Document Intelligence ----
# A thin FastAPI service that forwards documents to Document Intelligence. No local
# model and no GPU, so this is a small slim image (the old CUDA + baked-weights
# image is gone).
#
# Secrets are NOT baked in. At runtime the container reads AZURE_DOCINTEL_ENDPOINT
# and AZURE_DOCINTEL_KEY from the environment, injected from Azure Key Vault via the
# container's managed identity — never from local.env (which is dev-only and
# excluded by .dockerignore).
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
