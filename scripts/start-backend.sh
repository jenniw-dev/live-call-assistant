#!/bin/bash
# Start the backend server
cd "$(dirname "$0")/../backend"

# Create venv if not exists
if [ ! -d ".venv" ]; then
    echo "📦 Creating virtual environment..."
    python -m venv .venv
fi

# Activate
source .venv/Scripts/activate 2>/dev/null || source .venv/bin/activate

# Install dependencies
echo "📦 Installing dependencies..."
pip install -r requirements.txt -q

# Check .env
if [ ! -f "../.env" ]; then
    echo "⚠️  No .env file found. Copying from .env.example..."
    cp ../.env.example ../.env
    echo "📝 Please edit .env to set KB_DIR to your markdown files directory"
fi

# Start server
echo "🚀 Starting backend on 127.0.0.1:8001..."
uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
