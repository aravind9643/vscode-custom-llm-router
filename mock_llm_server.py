#!/usr/bin/env python3
"""
Custom LLM Router - Python Mock Server
A lightweight, zero-dependency OpenAI-compatible mock server for testing
model discovery, streaming chat completions, reasoning deltas, and tool-calling.

Run:
    python mock_llm_server.py [port]
Default port: 8000 (http://127.0.0.1:8000)
"""

import sys
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

MOCK_MODELS = [
    {
        "id": "mock-gpt-4o",
        "object": "model",
        "created": 1700000000,
        "owned_by": "mock-server",
        "toolCalling": True,
        "vision": True,
        "context_window": 128000,
        "max_output_tokens": 16384,
    },
    {
        "id": "mock-coder-32b",
        "object": "model",
        "created": 1700000000,
        "owned_by": "mock-server",
        "toolCalling": True,
        "vision": False,
        "context_window": 64000,
        "max_output_tokens": 8192,
    },
    {
        "id": "mock-deepseek-r1",
        "object": "model",
        "created": 1700000000,
        "owned_by": "mock-server",
        "toolCalling": True,
        "vision": False,
        "thinking": True,
        "context_window": 128000,
        "max_output_tokens": 16384,
    },
]


class MockOpenAIHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/v1/models") or self.path.startswith("/models"):
            response_data = {"object": "list", "data": MOCK_MODELS}
            body = json.dumps(response_data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path in ("/", "/health"):
            body = json.dumps({"status": "online", "models": len(MOCK_MODELS)}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def do_POST(self):
        if self.path.startswith("/v1/chat/completions") or self.path.startswith("/chat/completions"):
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
            try:
                payload = json.loads(raw_body)
            except Exception:
                payload = {}

            model = payload.get("model", "mock-gpt-4o")
            stream = payload.get("stream", True)
            messages = payload.get("messages", [])

            # Extract user text
            last_user_msg = "Hello!"
            for m in reversed(messages):
                if m.get("role") == "user":
                    content = m.get("content", "")
                    if isinstance(content, str):
                        last_user_msg = content
                    elif isinstance(content, list):
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "text":
                                last_user_msg = c.get("text", "")
                    break

            # Handle mock test ping
            if "Reply with exactly OK." in last_user_msg:
                self._handle_ok_response(model, stream)
                return

            if stream:
                self._handle_streaming_chat(model, last_user_msg)
            else:
                self._handle_non_streaming_chat(model, last_user_msg)
        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def _handle_ok_response(self, model: str, stream: bool):
        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self._send_cors_headers()
            self.end_headers()

            chunk = {
                "id": f"chatcmpl-{int(time.time())}",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {"content": "OK."}, "finish_reason": None}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            res = {
                "id": f"chatcmpl-{int(time.time())}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK."}, "finish_reason": "stop"}],
            }
            body = json.dumps(res).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def _handle_streaming_chat(self, model: str, user_prompt: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self._send_cors_headers()
        self.end_headers()

        req_id = f"chatcmpl-{int(time.time())}"

        # If model is reasoning, stream reasoning thoughts first
        if "deepseek-r1" in model or "reasoning" in model:
            thoughts = [
                "Thinking process:\n",
                f"1. Analyzing user input: \"{user_prompt[:50]}\"\n",
                "2. Formulating clean solution...\n\n",
            ]
            for t in thoughts:
                chunk = {
                    "id": req_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"reasoning_content": t}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.04)

        # Stream answer chunks
        words = f"Hello! This is a live response streamed from **{model}** via your local Python mock endpoint. You asked: \"{user_prompt}\".".split(" ")

        for w in words:
            chunk = {
                "id": req_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {"content": w + " "}, "finish_reason": None}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
            self.wfile.flush()
            time.sleep(0.03)

        # Send completion chunk
        final_chunk = {
            "id": req_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        self.wfile.write(f"data: {json.dumps(final_chunk)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _handle_non_streaming_chat(self, model: str, user_prompt: str):
        res = {
            "id": f"chatcmpl-{int(time.time())}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": f"Hello! Response from {model}. You said: {user_prompt}",
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        body = json.dumps(res).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Concise logging
        sys.stdout.write(f"[Mock Server] {args[0]} - {args[1]} {args[2]}\n")
        sys.stdout.flush()


def run_server(port=8000):
    server = HTTPServer(("127.0.0.1", port), MockOpenAIHandler)
    print("=" * 60)
    print(f"🚀 Custom LLM Router Mock Server running at http://127.0.0.1:{port}")
    print(f"   - Discovery URL: http://127.0.0.1:{port}/v1/models")
    print(f"   - Chat URL:      http://127.0.0.1:{port}/v1/chat/completions")
    print("   - Press Ctrl+C to stop.")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping mock server.")
        server.server_close()


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    run_server(port_arg)
