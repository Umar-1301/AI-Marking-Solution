# ---- Chandra OCR service: Azure GPU production image (linux/amd64) ----
# Chandra is a vision-transformer OCR model. Local testing proved CPU inference
# is ~5-7 min/page (unusable); on a GPU it runs in seconds. This image therefore
# targets an NVIDIA GPU on Azure Container Apps (serverless GPU, e.g. T4).
#
# Cross-build from an arm64 Mac and push straight to Azure Container Registry:
#   docker buildx build --platform linux/amd64 \
#     -t <registry>.azurecr.io/chandra-ocr:<tag> --push .
#
# It cannot be run locally (no NVIDIA GPU on the Mac) — first real run is on Azure.
# Deploy with internal ingress only: the backend reaches it via AI_SERVICE_URL,
# the browser never touches it.

# CUDA 13 runtime — matches the cu13 libraries torch 2.11 bundles (seen in the
# build: cuda_toolkit-13.0.2 / nvidia_cudnn_cu13). cudnn is included in this tag.
# VERIFY this CUDA version against Azure's current serverless-GPU host driver
# before release.
FROM nvidia/cuda:13.0.0-cudnn-runtime-ubuntu24.04

# Python + the native libs Pillow / pypdfium2 link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# TORCH_DEVICE=cuda runs the model on the GPU (the whole point of this image).
# HF_HOME is where the baked weights live. PIP_BREAK_SYSTEM_PACKAGES bypasses
# Ubuntu 24.04's PEP 668 guard so we can pip-install into the system interpreter.
ENV TORCH_DEVICE=cuda \
    TORCH_ATTN=eager \
    HF_HOME=/models \
    PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# Python deps. On linux/amd64 the pinned torch resolves to the CUDA build
# automatically — same requirements.txt as local, correct platform/base (I5).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the model weights into the image. snapshot_download is a pure file pull
# (no model construction), so it needs no GPU at build time. ~5.6 GB — this is
# the layer that makes the image large but cold starts predictable.
RUN python3 -c "from huggingface_hub import snapshot_download; snapshot_download('datalab-to/chandra-ocr-2')"

COPY . .

# Load weights from the baked cache only — never reach out to Hugging Face at
# runtime, so a blocked/slow HF can't stall a cold start.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
