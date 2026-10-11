---
title: Cyclops API
emoji: 🦯
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 8000
pinned: false
---

Backend for Cyclops (Knight Hacks IX). Depth Anything V2 finds obstacles in the walking path, DETR names them, ElevenLabs speaks the result.

`POST /describe` and `POST /sonar` take a multipart `image` and `mode` (`indoor` or `outdoor`). `GET /health` returns `{"ok": true}`.
