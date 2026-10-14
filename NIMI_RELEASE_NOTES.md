# OpenWhispr 1.10.5 for Nimi

Windows x86_64 release with published Nimi SDK 0.21, Kit/native 0.19.3 and Electron 44.

- Dictate, transcribe audio files and use the assistant with Nimi-managed AI models.
- Keep original transcription when optional cleanup fails, and retain partial chat replies when navigating away.
- Include the native Windows keyboard/paste helpers, microphone listener, FFmpeg, yt-dlp and Qdrant with their notices.
- Preserve Host runtime dependencies and verify SQLite with the packaged Electron runtime before shipping.
- Supply the portable release notes required for Registry admission. Version 1.10.4 remains immutable; it lacked this information field.

Local installed-package acceptance on Nimi 0.2.4 completed file selection, real transcription, note persistence after reload, and MiMo note search/read with navigation back to the original note. This does not claim a new microphone/paste test, Catalog admission, macOS/Linux acceptance, or native meeting echo cancellation. Optional third-party accounts remain separate from Nimi access.
