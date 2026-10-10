"""Deploy the backend to the Hugging Face Space. Run from backend/ after `hf auth login` with a write token:

    python deploy_space.py

Uploads this folder (never .env or venv), copies the ElevenLabs key from .env into the Space's secrets,
and the Space rebuilds itself. The app's EXPO_PUBLIC_API_URL should be SPACE_URL.
"""
import os

from dotenv import load_dotenv
from huggingface_hub import HfApi

SPACE_ID = "michaelmccamy/obstacle-alert-api"
SPACE_URL = "https://michaelmccamy-obstacle-alert-api.hf.space"
HERE = os.path.dirname(os.path.abspath(__file__))

load_dotenv(os.path.join(HERE, ".env"))
api = HfApi()
# Public, so the app can reach it without a token. Keys live in Space secrets, not the code.
# Free cpu-basic needs PRO, so this runs on paid cpu-upgrade (billed to account credits) and
# sleeps after an hour with no requests. The first request after sleeping takes about a minute.
api.create_repo(
    SPACE_ID, repo_type="space", space_sdk="docker", space_hardware="cpu-upgrade", space_sleep_time=3600, exist_ok=True
)

for name in ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"):
    if os.getenv(name):
        api.add_space_secret(SPACE_ID, name, os.environ[name])

api.upload_folder(
    repo_id=SPACE_ID,
    repo_type="space",
    folder_path=HERE,
    ignore_patterns=[".env", "venv/*", "__pycache__/*", "*.pyc", "space_README.md", "deploy_space.py", "depth_test.py", "tune.py"],
    commit_message="Deploy backend",
)
api.upload_file(
    repo_id=SPACE_ID,
    repo_type="space",
    path_or_fileobj=os.path.join(HERE, "space_README.md"),
    path_in_repo="README.md",
    commit_message="Space card",
)
print(f"Uploaded. Building at https://huggingface.co/spaces/{SPACE_ID} (5 to 10 minutes the first time).")
print(f"API URL once running: {SPACE_URL}")
