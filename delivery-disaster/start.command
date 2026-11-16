#!/bin/bash
# Mac: double-click to install (first time) and run the game server.
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
echo "Delivery Disaster running at http://localhost:3000  (Ctrl+C to stop)"
(sleep 2 && open "http://localhost:3000") &
npm start
