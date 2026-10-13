#!/bin/bash
# Start the frontend dev server
cd "$(dirname "$0")/../frontend"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    npm install
fi

# Start dev server
echo "🚀 Starting frontend on port 5173..."
npm run dev
