#!/bin/bash
# Rebuild FAISS index from knowledge base
# Usage: ./rebuild-index.sh          (default port 8001)
#        PORT=8000 ./rebuild-index.sh (custom port)
PORT="${PORT:-8001}"
echo "🔨 Rebuilding knowledge base index (port $PORT)..."
curl -s -X POST "http://localhost:$PORT/api/rebuild" | python -m json.tool
echo ""
echo "✅ Done! Check http://localhost:$PORT/api/health for index size."
