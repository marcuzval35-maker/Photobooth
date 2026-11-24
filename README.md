# NEON SNAP — AI Photobooth

Web-based AI Photobooth powered by Node.js, Express, and the official `@google/genai` SDK (`gemini-2.5-flash-image`).

## Project Structure

```text
ai-photobooth/
├── .env.example
├── package.json
├── server.js
├── README.md
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## Setup & Running Locally

1. Copy `.env.example` to `.env` and add your Gemini API key:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in your browser and grant camera access.

> **Note on QR Sharing & Mobile Access:** Browsers block `navigator.mediaDevices.getUserMedia` on non-`localhost` HTTP origins. For live events where guests scan QR codes on phones, expose port `3000` over HTTPS (e.g., Cloudflare Tunnel or ngrok) and set `PUBLIC_BASE_URL` in `.env` to that public HTTPS URL.
