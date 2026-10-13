# Live Call Assistant for Mac: user guide

This build runs only on Apple Silicon Macs and is an unsigned local build. Raw audio, local speech recognition and the full knowledge base stay on this Mac and are never sent to DeepSeek. When you ask for a cloud answer, the app sends the current question, the last two Q&A rounds, the selected knowledge-base sections and the system prompt. When you use "Clean up question", it sends the current question and the clean-up system prompt.

## First launch

1. Double-click `Live Call Assistant.app`.
2. Paste your DeepSeek API key in the app and click "Save securely and start". Don't paste the key into chats or project files.
3. Click the listen button and, in the macOS share picker, choose the source that plays the call audio and allow system audio.

The first launch loads the local speech and retrieval models, which can take a few seconds.

### If macOS blocks the app

This is an unsigned build for personal use. If macOS says it can't verify the developer, close the message, Control-click `Live Call Assistant.app` in Finder and choose Open, then Open again. If it's still blocked, go to System Settings → Privacy & Security and choose Open Anyway.

## During a call

1. Check the status shows "Listening".
2. The customer's question appears in the input box. Edit it if needed.
3. Click Send. The app searches the product docs first and only uses DeepSeek tokens when the docs and the answer cache can't answer directly.
4. `Command+Shift+Space` shows or hides the window.

Recognised text only goes into the input box; it is never sent automatically.

## DeepSeek usage

DeepSeek is called only when you click Send and the docs or cache can't answer directly, or when you click "Clean up question". A cloud answer includes the current question, the last two Q&A rounds, up to three selected knowledge-base sections (only on a partial match) and the system prompt. Saving the key doesn't call DeepSeek.

## Permissions

Go to System Settings → Privacy & Security and allow Live Call Assistant to record the screen and system audio, then quit and reopen the app. The app uses the system audio you pick in the share picker; it never falls back to the microphone.

## Replace or remove the key

Open Settings (top right) and choose "Replace key securely" or "Remove API key". The app never shows the stored key.

## Quit and uninstall

Quit from the menu bar or window menu, not just by hiding the window. To uninstall, quit the app, move it to the Trash, and optionally delete `~/Library/Application Support/live-call-assistant-desktop`, which removes the encrypted key and settings from this Mac.

## Troubleshooting

### Stuck on loading
The first launch can take a few seconds. If it takes more than a minute, quit and reopen the app, and check the Mac has free disk space.

### No sound or no transcript
After clicking listen, pick the source that's actually playing the call audio, and check that system audio recording is allowed. After changing permissions, quit and reopen the app.

### Key, quota or network errors
Replace the key in Settings and check your internet connection. For quota or rate-limit errors, check your DeepSeek account or wait a moment.
