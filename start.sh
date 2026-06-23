#!/bin/bash
# Start backend and frontend concurrently

# Install deps if needed
if [ ! -d "quark-ide/backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  cd quark-ide/backend && npm install && cd ../..
fi

if [ ! -d "quark-ide/frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  cd quark-ide/frontend && npm install && cd ../..
fi

# Start backend
cd quark-ide/backend && npm run dev &
BACKEND_PID=$!

# Give backend a moment to start
sleep 2

# Start frontend
cd quark-ide/frontend && npm run dev &
FRONTEND_PID=$!

# Wait for either process to exit
wait $BACKEND_PID $FRONTEND_PID
