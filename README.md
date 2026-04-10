# Conferly - Secure Video Conference Website

Professional video conferencing website built with Next.js, React, and WebRTC.

## What This Project Includes

- Secure room join using Room ID + Security Key
- Multi-participant browser video calls using WebRTC mesh networking
- Real-time signaling over WebSocket (no external paid API)
- No database required (all room state is in memory)
- Free built-in features:
	- Mute / unmute microphone
	- Camera on / off
	- Screen sharing
	- Copy invite details
	- Participant tiles

## Tech Stack

- Next.js (App Router) + React + TypeScript
- Native WebRTC (`RTCPeerConnection`)
- Native WebSocket signaling using the `ws` package
- Tailwind CSS

## Run Locally

Install dependencies:

```bash
npm install
```

Start in development mode:

```bash
npm run dev
```

Run full local stack (Next.js + built-in WebSocket signaling server):

```bash
npm run dev:full
```

Build for production:

```bash
npm run build
```

Start production server:

```bash
npm run start
```

Start full production stack with built-in signaling server:

```bash
npm run start:full
```

Open http://localhost:3000

## How Security Key Works

- The first user creates a room by joining with a Room ID and Security Key.
- That room key is kept in server memory for the room lifecycle.
- New users can only join the same room if they provide the exact same key.

## Important Notes

- This project does not use a database by design.
- Room and participant data reset when the server restarts.
- Browser permissions for camera/microphone are required.
- For internet deployment (outside local network), add TURN servers for NAT traversal reliability.

## Deploy On Vercel

This app can be deployed on Vercel as a Next.js frontend.

Important: Vercel does not run this project's custom Node WebSocket server (`server.mjs`) as a persistent process.
For real-time conferencing in production, deploy signaling server separately and point the frontend to it.

1. Push the project to GitHub.
2. Import the repository in Vercel.
3. In Vercel Project Settings -> Environment Variables, set:

```bash
NEXT_PUBLIC_SIGNALING_URL=wss://your-signaling-server.example.com/ws
```

4. Deploy.

### Build Settings (Vercel)

- Framework Preset: `Next.js`
- Build Command: `npm run build`
- Output: default Next.js output

### If You Keep Signaling On Another Host

- Ensure CORS and network access allow browser WebSocket connections.
- Use `wss://` in production.
