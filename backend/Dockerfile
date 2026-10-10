# Hugging Face Space image for the backend. Deploy with: python deploy_space.py
FROM python:3.12-slim

# Spaces run as user 1000.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH HF_HOME=/home/user/.cache/huggingface
WORKDIR /home/user/app

# CPU-only torch is a fraction of the size of the default CUDA build. torchvision (pulled in by timm)
# must come from the same index, or it won't match torch and transformers fails to import.
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --user -r requirements.txt

# Download the models during the build so the first request isn't slow.
RUN python -c "from transformers import pipeline; \
pipeline('depth-estimation', model='depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf'); \
pipeline('depth-estimation', model='depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf'); \
pipeline('object-detection', model='facebook/detr-resnet-50'); \
from transformers import AutoModel, AutoProcessor; \
AutoProcessor.from_pretrained('google/siglip-base-patch16-224'); AutoModel.from_pretrained('google/siglip-base-patch16-224')"

COPY --chown=user . .
CMD ["python", "main.py"]
