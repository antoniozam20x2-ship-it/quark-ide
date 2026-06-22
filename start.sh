#!/bin/bash
# Start backend and frontend concurrently
cd quark-ide/backend && npm run dev &
BACKEND_PID=$!

cd quark-ide/frontend && npm run dev &
FRONTEND_PID=$!

# Wait for either process to exit
wait $BACKEND_PID $FRONTEND_PID
