# My Prompt Logger

Personal Chrome extension for tracking AI usage and improving productivity.

## Overview

My Prompt Logger automatically captures:

- Prompt text
- Assistant response
- Site (ChatGPT / Claude / Gemini)
- Timestamp
- Current URL

All data is stored locally using IndexedDB via background service worker.

No server. No external upload.

---

## Why This Exists

I use multiple AI tools (ChatGPT, Codex CLI, etc.).
This extension helps me:

- Track what I asked
- Reuse successful prompts
- Analyze productivity patterns
- Export logs to Excel

---

## Features

- Auto-detect prompt submission (click / Enter)
- MutationObserver-based response detection
- Excel export
- Site filter
- Delete individual records
- Delete all logs

---

## Installation

1. Clone this repository
2. Open Chrome → chrome://extensions
3. Enable Developer Mode
4. Click "Load unpacked"
5. Select the project folder

---

## Data Policy

All data is stored locally in the browser.
No external server communication.

---

## Version

v0.1.0 – Initial working version
