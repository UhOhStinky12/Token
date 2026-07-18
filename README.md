# Live Token Meter

A SillyTavern extension that tracks token usage **per chat**, live, and shows how full your context window is right now.

Built for SillyTavern 1.18.x. Backend-agnostic (tested with LM Studio, works with any Text Completion or Chat Completion backend).

## Why this doesn't read LM Studio's `usage` field directly

SillyTavern's public extension API doesn't give a stable, documented way to read the raw `usage.prompt_tokens` / `usage.completion_tokens` object a backend like LM Studio returns — that's internal wiring that varies by backend and can change between ST releases. Instead, this extension uses SillyTavern's *own* accounting, which is version-stable and works identically no matter what backend you connect:

- `generate_interceptor` (a documented manifest hook) is called by SillyTavern right before every real generation, and hands the extension the actual finalized chat-history array about to be used for prompt building. The extension tokenizes that with ST's own tokenizer to get a real chat-history token count.
- The same hook also passes a `contextSize` number — but that turns out to be the *token budget* SillyTavern computed (roughly Context Size − Response Length), not the number of tokens actually used. It's shown separately, honestly labeled "Context budget available," rather than presented as if it were the real prompt size.
- `getTokenCountAsync()` (from `SillyTavern.getContext()`) is the same tokenizer SillyTavern itself uses to budget your prompt. The extension uses it to estimate live context usage — including while you're still typing — and to count each new AI reply for the "Response tokens" total.
- `context.maxContext` is SillyTavern's own current max-context value, so the meter always matches whatever you have configured (LM Studio's context size, ST's Response settings, etc.) without needing separate configuration.

## Features

- **Per-chat totals** — prompt / completion / total tokens, stored in the chat file itself (via chat metadata), so each chat keeps its own numbers and nothing gets mixed together.
- **Live context meter** — a color-coded bar showing current context usage vs. max context, updating as messages are sent/received/edited/deleted and as you type in the input box.
- **Last request panel** — exact prompt/response/total token counts for the most recent generation.
- **Floating draggable widget** — a small always-on-top readout you can drag anywhere on screen; position is remembered.
- **Reset / Export / Import** — reset just the current chat's stats, export them to a `.json` file, or restore them later.
- **Configurable warn/danger thresholds** — color the meter yellow/red as you approach your max context.

## Installation

1. Push this folder to a GitHub repository (see below).
2. In SillyTavern, open the **Extensions** panel (the plug icon) → **Install Extension**.
3. Paste your repository's URL and confirm.
4. Refresh SillyTavern. Open the Extensions settings panel and expand **Live Token Meter** to configure it; a small floating widget will also appear on screen.

### Manual install (alternative)

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/YOUR_USERNAME/ST-Live-Token-Meter.git
```

Then refresh SillyTavern and enable the extension from the Extensions panel.

## Publishing this to GitHub

```bash
cd ST-Live-Token-Meter
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ST-Live-Token-Meter.git
git push -u origin main
```

Then update `homePage` in `manifest.json` to point at that URL (optional, cosmetic).

## Notes / limitations

- **"Chat history" numbers only count visible chat messages.** SillyTavern doesn't expose character card, persona, or world info tokens to extensions in a stable way, so those aren't included. The "Context budget available" figure (Context Size − Response Length) *is* exact, but it's a ceiling, not a measurement - it stays roughly constant regardless of how much of the chat is actually used. For the full, exact breakdown (description, scenario, persona, world info, everything), use SillyTavern's own built-in **Prompt Itemization** popup (the ⓘ icon on any message) - this extension is meant to complement that with an always-visible live glance, not replace it.
- Cumulative "Chat-history tokens sent" intentionally counts the *full* chat-history tokens re-sent on every single generation (not just new tokens since the last turn), since that matches how most local/remote backends actually process context each turn.
- If the floating widget doesn't appear, open the browser console (F12) and look for `[live_token_meter]` log lines - `init()` logs whether it found a place to inject the settings panel and whether the widget element actually landed in the DOM. There's also a **"Fix / Recreate Widget"** button in the settings panel that removes and re-creates it at the default bottom-right position, which clears out any bad saved drag position.
- Stats live in the chat's metadata, so they travel with the chat file if you export/back it up, and are naturally separate per chat/character.

## File structure

```
ST-Live-Token-Meter/
├── manifest.json
├── index.js
├── style.css
├── README.md
└── LICENSE
```

## License

MIT — see `LICENSE`.
