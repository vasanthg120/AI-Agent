FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch first: sentence-transformers needs torch, and the default
# Linux wheel bundles CUDA libraries (several GB) that a CPU-only server never
# uses. Installed before requirements.txt so pip keeps this build.
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the embedding model into the image so containers don't need network
# access on first request.
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

COPY app ./app
# A syntax error anywhere fails the build here, not at the first request.
RUN python -m compileall -q app

EXPOSE 8000
# One worker on purpose: the scheduler (CRM sync, reports) runs inside the process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
