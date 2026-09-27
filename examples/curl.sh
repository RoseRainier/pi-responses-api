#!/bin/sh
# Streaming request with curl. Add -H "Authorization: Bearer $KEY" if apiKeys is configured.
BASE=${PI_RESPONSES_URL:-http://127.0.0.1:8321/v1}

curl -N "$BASE/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pi",
    "instructions": "Answer briefly.",
    "input": "What is in package.json?",
    "stream": true,
    "pi_tools": ["read", "ls"]
  }'
