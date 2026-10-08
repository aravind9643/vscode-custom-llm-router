#!/usr/bin/env python3
"""
Custom LLM Router - Python Mock Server
A lightweight, zero-dependency OpenAI-compatible mock server for testing
model discovery, streaming chat completions, reasoning deltas, and tool-calling.

Run:
    python mock_llm_server.py [port]
Default port: 31415 (http://127.0.0.1:31415)

Test hooks:
    mock-flaky    streaming chat always fails with 503 (route fallback)
    mock-strict   rejects the stream_options field (usage fallback)
    mock-coder-32b accepts tools but answers in text; mock-qwq-think rejects tools
    /api/show, /api/pull, /api/generate imitate Ollama; GET /_mock/state lists keep-alive calls
"""

import sys
import json
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

MOCK_MODELS = [
    {
        "id": "mock-gpt-4o",
        "object": "model",
        "pricing": {"prompt": "0.000002", "completion": "0.000008"},
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
    {
        "id": "mock-qwq-think",
        "object": "model",
        "created": 1700000000,
        "owned_by": "mock-server",
        "context_window": 32768,
    },
    {"id": "mock-flaky", "object": "model", "created": 1700000000, "owned_by": "mock-server"},
    {"id": "mock-strict", "object": "model", "created": 1700000000, "owned_by": "mock-server"},
    {"id": "mock-slow", "object": "model", "created": 1700000000, "owned_by": "mock-server"},
]

KEEP_ALIVE_CALLS = []
STATE = {"lastAnthropic": None, "lastOllamaChat": None, "coldStarted": False}

ANTHROPIC_MODELS = [
    {"type": "model", "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "created_at": "2026-09-01T00:00:00Z",
     "max_input_tokens": 1000000, "max_tokens": 128000,
     "capabilities": {"image_input": {"supported": True}, "thinking": {"supported": True, "types": {"adaptive": {"supported": True}, "enabled": {"supported": False}}}}},
    {"type": "model", "id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5", "created_at": "2025-10-01T00:00:00Z",
     "max_input_tokens": 200000, "max_tokens": 64000,
     "capabilities": {"image_input": {"supported": True}, "thinking": {"supported": True, "types": {"adaptive": {"supported": False}, "enabled": {"supported": True}}}}},
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

    def _gate(self) -> bool:
        """Paths under /secure need `Authorization: Bearer sk-good` or `X-Secret-Token: tok`."""
        if not self.path.startswith("/secure"):
            return True
        self.path = self.path[len("/secure"):]
        if self.headers.get("Authorization") == "Bearer sk-good" or self.headers.get("X-Secret-Token") == "tok":
            return True
        self._json(401, {"error": {"message": "Invalid API key"}})
        return False

    def _is_anthropic(self) -> bool:
        return self.headers.get("anthropic-version") is not None

    def do_GET(self):
        if not self._gate():
            return
        if self._is_anthropic() and self.path.startswith("/v1/models"):
            if self.headers.get("x-api-key") != "sk-ant-test":
                return self._json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
            return self._json(200, {"data": ANTHROPIC_MODELS, "has_more": False, "first_id": ANTHROPIC_MODELS[0]["id"], "last_id": ANTHROPIC_MODELS[-1]["id"]})
        if self.path.startswith("/v1/models") or self.path.startswith("/models"):
            response_data = {"object": "list", "data": MOCK_MODELS}
            body = json.dumps(response_data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/_mock/state":
            self._json(200, {"keepAlive": KEEP_ALIVE_CALLS, **STATE})
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

    def _json(self, status: int, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _done(self, model: str):
        """Optional usage chunk (when stream_options.include_usage was sent), then [DONE]."""
        if getattr(self, "_usage", None):
            self._write_sse_raw({"id": "chatcmpl-mock", "object": "chat.completion.chunk", "model": model, "choices": [], "usage": self._usage})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _write_sse_raw(self, chunk: dict):
        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _handle_ollama_native(self, payload: dict):
        if self.path == "/api/show":
            model = payload.get("model", "")
            if model not in [m["id"] for m in MOCK_MODELS]:
                return self._json(404, {"error": f"model '{model}' not found"})
            caps = ["completion"] + (["tools"] if model != "mock-qwq-think" else []) + (["vision"] if "4o" in model else []) + (["thinking"] if "think" in model or "r1" in model else [])
            return self._json(200, {"model_info": {"general.architecture": "llama", "llama.context_length": 40960}, "capabilities": caps})
        if self.path == "/api/chat":
            STATE["lastOllamaChat"] = payload
            msgs = payload.get("messages", [])
            last = next((m.get("content", "") for m in reversed(msgs) if m.get("role") == "user"), "")
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            def emit(obj):
                self.wfile.write((json.dumps(obj) + "\n").encode("utf-8"))
                self.wfile.flush()
            model = payload.get("model")
            if payload.get("think"):
                emit({"model": model, "message": {"role": "assistant", "content": "", "thinking": "Native thinking."}, "done": False})
            if payload.get("tools") and ("weather" in last.lower() or "calculator" in last.lower()):
                name = "calculator" if "calculator" in last.lower() else "get_weather"
                args = {"expression": "1234*5678"} if name == "calculator" else {"city": "Hyderabad"}
                emit({"model": model, "message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}, "done": False})
            else:
                for piece in ["Hello from ", "native ", str(model)]:
                    emit({"model": model, "message": {"role": "assistant", "content": piece}, "done": False})
            chars = sum(len(m.get("content") or "") for m in msgs)
            emit({"model": model, "message": {"role": "assistant", "content": ""}, "done": True, "prompt_eval_count": max(1, chars // 3), "eval_count": 12})
            return
        if self.path == "/api/generate":
            KEEP_ALIVE_CALLS.append({"model": payload.get("model"), "keep_alive": payload.get("keep_alive")})
            return self._json(200, {"model": payload.get("model"), "done": True, "response": ""})
        if self.path == "/api/pull":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            for evt in [{"status": "pulling manifest"}, {"status": "pulling abc", "total": 100, "completed": 40}, {"status": "pulling abc", "total": 100, "completed": 100}, {"status": "success"}]:
                self.wfile.write((json.dumps(evt) + "\n").encode("utf-8"))
                self.wfile.flush()
            MOCK_MODELS.append({"id": payload.get("model"), "object": "model", "created": 1700000000, "owned_by": "library"})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            payload = json.loads(raw_body)
        except Exception:
            payload = {}
        if not self._gate():
            return
        if self.path.startswith("/api/"):
            return self._handle_ollama_native(payload)
        if self._is_anthropic() and self.path.startswith("/v1/messages"):
            return self._handle_anthropic(payload)
        if self.path.startswith("/v1/chat/completions") or self.path.startswith("/chat/completions"):

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

            if model == "mock-strict" and "stream_options" in payload:
                return self._json(400, {"error": {"message": "Unrecognized request argument supplied: stream_options"}})
            is_health = "Reply with exactly" in last_user_msg
            is_tool_check = bool(payload.get("tools")) and "calculator tool" in last_user_msg
            if model == "mock-slow" and not STATE["coldStarted"]:
                STATE["coldStarted"] = True
                time.sleep(2.5)  # first request loads the model
            if stream and model == "mock-flaky" and not is_health and not is_tool_check:
                return self._json(503, {"error": {"message": "upstream overloaded"}})
            if is_tool_check:
                if model == "mock-qwq-think":
                    return self._json(400, {"error": {"message": "this model does not support tools"}})
                if model == "mock-coder-32b":
                    return self._handle_streaming_chat(model, "1234*5678 is 7006652") if stream else self._handle_non_streaming_chat(model, last_user_msg)
                if stream:
                    self._usage = None
                    return self._handle_tool_call_stream(model, "calculator", ['{"expression": ', '"1234*5678"', '}'])
                return self._json(200, {"id": "chatcmpl-mock", "object": "chat.completion", "model": model, "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "calculator", "arguments": "{\"expression\": \"1234*5678\"}"}}]}}]})

            # Deterministic usage: 3 characters per prompt token.
            chars = sum(len(m.get("content") or "") if isinstance(m.get("content"), str) else 0 for m in messages)
            self._usage = {"prompt_tokens": max(1, chars // 3), "completion_tokens": 20} if (payload.get("stream_options") or {}).get("include_usage") else None

            # Handle mock test ping
            if "Reply with exactly OK." in last_user_msg:
                self._handle_ok_response(model, stream)
                return

            if stream and payload.get("tools") and "weather" in last_user_msg.lower():
                self._handle_tool_call_stream(model)
            elif stream and "think" in model:
                self._handle_think_tag_stream(model)
            elif stream:
                self._handle_streaming_chat(model, last_user_msg)
            else:
                self._handle_non_streaming_chat(model, last_user_msg)
        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def _handle_anthropic(self, payload: dict):
        STATE["lastAnthropic"] = {
            "body": payload,
            "headers": {k: self.headers.get(k) for k in ("x-api-key", "anthropic-version", "anthropic-beta", "authorization")},
        }
        if self.headers.get("x-api-key") != "sk-ant-test":
            return self._json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        msgs = payload.get("messages", [])
        last = ""
        for m in reversed(msgs):
            if m.get("role") == "user":
                content = m.get("content")
                if isinstance(content, str):
                    last = content
                else:
                    last = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
                break
        model = payload.get("model")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self._send_cors_headers()
        self.end_headers()
        def ev(name, data):
            self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
            self.wfile.flush()
        usage = {"input_tokens": 30, "output_tokens": 0, "cache_read_input_tokens": 10}
        ev("message_start", {"type": "message_start", "message": {"id": "msg_mock", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage}})
        idx = 0
        if (payload.get("thinking") or {}).get("display") == "summarized":
            ev("content_block_start", {"type": "content_block_start", "index": idx, "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
            ev("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "thinking_delta", "thinking": "Considering the request."}})
            ev("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "signature_delta", "signature": "sig"}})
            ev("content_block_stop", {"type": "content_block_stop", "index": idx})
            idx += 1
        stop = "end_turn"
        stop_details = None
        if "refuse-me" in last:
            stop, stop_details = "refusal", {"type": "refusal", "category": "cyber", "explanation": "mock refusal"}
        elif payload.get("tools") and ("weather" in last.lower() or "calculator" in last.lower()):
            name = "calculator" if "calculator" in last.lower() else "get_weather"
            ev("content_block_start", {"type": "content_block_start", "index": idx, "content_block": {"type": "tool_use", "id": "toolu_mock", "name": name, "input": {}}})
            for part in (['{"expression": ', '"1234*5678"}'] if name == "calculator" else ['{"city": ', '"Hyderabad"}']):
                ev("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": part}})
            ev("content_block_stop", {"type": "content_block_stop", "index": idx})
            stop = "tool_use"
        else:
            ev("content_block_start", {"type": "content_block_start", "index": idx, "content_block": {"type": "text", "text": ""}})
            for piece in ["Hello from ", str(model)]:
                ev("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "text_delta", "text": piece}})
            ev("content_block_stop", {"type": "content_block_stop", "index": idx})
        delta = {"stop_reason": stop, "stop_sequence": None}
        if stop_details:
            delta["stop_details"] = stop_details
        ev("message_delta", {"type": "message_delta", "delta": delta, "usage": {"output_tokens": 15}})
        ev("message_stop", {"type": "message_stop"})

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
            self._done(model)
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
        self._done(model)
        self.wfile.flush()

    def _write_sse(self, model: str, delta: dict, finish=None):
        chunk = {
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _start_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self._send_cors_headers()
        self.end_headers()

    def _handle_think_tag_stream(self, model: str):
        """Inline <think> tags deliberately split across chunk boundaries."""
        self._start_sse()
        for piece in ["<thi", "nk>Let me ", "consider this.</th", "ink>The answer ", "is 42."]:
            self._write_sse(model, {"content": piece})
            time.sleep(0.02)
        self._write_sse(model, {}, "stop")
        self._done(model)

    def _handle_tool_call_stream(self, model: str, name: str = "get_weather", parts=None):
        """Streams one tool call with its JSON arguments split over several deltas."""
        self._start_sse()
        self._write_sse(model, {"tool_calls": [{"index": 0, "id": "call_mock_1", "type": "function", "function": {"name": name, "arguments": ""}}]})
        for part in parts or ['{"city": ', '"Hyderabad"', '}']:
            self._write_sse(model, {"tool_calls": [{"index": 0, "function": {"arguments": part}}]})
        self._write_sse(model, {}, "tool_calls")
        self._done(model)

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


def run_server(port=31415):
    # Windows consoles / pipes may not be UTF-8; never crash on the banner.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    server = ThreadingHTTPServer(("127.0.0.1", port), MockOpenAIHandler)
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
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else 31415
    run_server(port_arg)
