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
# Paid hardware billed to Michael's account credits (free cpu-basic Docker Spaces need PRO).
# t4-small cuts a frame from about 1.1 s to about 0.1 s of model time; "cpu-upgrade" is the cheap fallback.
SPACE_HARDWARE = "t4-small"
# Sleeps after an hour with no requests, so it doesn't bill overnight. The first request after
# sleeping takes about a minute.
SLEEP_S = 3600
HERE = os.path.dirname(os.path.abspath(__file__))

load_dotenv(os.path.join(HERE, ".env"))
api = HfApi()
# Public, so the app can reach it without a token. Keys live in Space secrets, not the code.
api.create_repo(
    SPACE_ID, repo_type="space", space_sdk="docker", space_hardware=SPACE_HARDWARE, space_sleep_time=SLEEP_S, exist_ok=True
)
if api.get_space_runtime(SPACE_ID).requested_hardware != SPACE_HARDWARE:
    api.request_space_hardware(SPACE_ID, SPACE_HARDWARE, sleep_time=SLEEP_S)

for name in ("ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "APP_KEY"):
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
