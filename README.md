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

Build for production:

```bash
npm run build
```

Start production server:

```bash
npm run start
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
