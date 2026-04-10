# Python Signaling Backend (PythonAnywhere)

This backend is protocol-compatible with the Conferly frontend WebSocket signaling.

## Files

- `signaling_server.py`: FastAPI WebSocket signaling server (`/ws`)
- `requirements.txt`: backend dependencies

## Local Run

1. Create and activate a virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Start server:

```bash
uvicorn signaling_server:app --host 0.0.0.0 --port 8000
```

4. Health check:

- `http://localhost:8000/health`

## PythonAnywhere Deployment

Use an ASGI app (WebSocket support requires ASGI).

1. Upload `python-backend/` to your PythonAnywhere project directory.
2. Create a virtualenv and install dependencies:

```bash
pip install -r /home/<your-username>/<project>/python-backend/requirements.txt
```

3. In PythonAnywhere Web tab, configure an ASGI app.
4. Point the ASGI callable to:

- `signaling_server:app`

5. Ensure your app serves `wss://<your-domain>/ws`.

6. In Vercel frontend environment variables, set:

- `NEXT_PUBLIC_SIGNALING_URL=wss://<your-domain>/ws`

7. Redeploy frontend on Vercel.

## Notes

- This backend keeps room data in memory only.
- Restarting the backend clears all active rooms.
- Add TURN servers in your frontend for better NAT traversal reliability.
