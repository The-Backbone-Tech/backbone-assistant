#!/usr/bin/env python3
"""A scripted OpenAI-compatible model for the VM journey. Stdlib only; loopback only.

It tests the harness and says nothing of how a real model behaves. In the folder `model` under the
home, `active` names a script in `scripts/<name>.json`, a list of steps; the step is the count of
tool results in the request, so a lost call is visible. Steps: {"call": name, "args": {...}},
{"final": text}, {"hold": name, "then": step} which touches `hold.<name>` and waits for `release.<name>`.
"""
import json
import select
import socket
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path.home() / "model"
PORT = 8900
MODEL = "scripted-1"


def script():
    name = (HOME / "active").read_text().strip()
    return json.loads((HOME / "scripts" / f"{name}.json").read_text())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self.send_json({"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "script", "created": 0, "context_length": 200000, "max_context_length": 200000}]})
        return self.send_json({"ok": True})

    def client_gone(self):
        ready, _, _ = select.select([self.connection], [], [], 0)
        return bool(ready) and not self.connection.recv(1, socket.MSG_PEEK)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        messages = body.get("messages") or []
        tools = [(t.get("function") or t).get("name") for t in body.get("tools") or []]
        steps = script()
        index = sum(1 for m in messages if m.get("role") == "tool")
        step = steps[index] if index < len(steps) else {"final": f"script exhausted at {index}"}
        with (HOME / "requests.jsonl").open("a") as log:
            log.write(json.dumps({"t": time.time(), "step": index, "tools": tools, "messages": messages}) + "\n")
        if "hold" in step:
            (HOME / f"hold.{step['hold']}").touch()
            while not (HOME / f"release.{step['hold']}").exists():
                time.sleep(0.1)
                if self.client_gone():
                    return
            step = step["then"]
        if "final" in step:
            delta, finish = {"content": step["final"]}, "stop"
        else:
            call = {"index": 0, "id": "call_" + uuid.uuid4().hex[:10], "type": "function", "function": {"name": step["call"], "arguments": json.dumps(step.get("args", {}))}}
            delta, finish = {"tool_calls": [call]}, "tool_calls"
        chunk_id = "chatcmpl-" + uuid.uuid4().hex[:12]
        usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}

        def chunk(d, fin=None, u=None):
            frame = {"id": chunk_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": MODEL, "choices": [{"index": 0, "delta": d, "finish_reason": fin}]}
            if u:
                frame["usage"] = u
            self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())
            self.wfile.flush()

        try:
            if not body.get("stream"):
                message = {"role": "assistant", "content": delta.get("content"), **({"tool_calls": delta["tool_calls"]} if "tool_calls" in delta else {})}
                return self.send_json({"id": chunk_id, "object": "chat.completion", "created": int(time.time()), "model": MODEL, "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": usage})
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("connection", "close")
            self.end_headers()
            chunk({"role": "assistant", "content": ""})
            chunk(delta)
            chunk({}, finish, usage)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    (HOME / "scripts").mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
