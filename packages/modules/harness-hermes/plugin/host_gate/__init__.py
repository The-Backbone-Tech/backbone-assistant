"""The gate inside Hermes. Stdlib only.

``pre_tool_call`` asks Backbone about every tool call, built-in and plugin alike, and only an
explicit ``allow`` lets it through; anything else, including no answer, is a block. The three door
tools carry the call to Backbone, whose ToolHost reaches the effect gateway. This is policy inside
the engine's process, not containment: Backbone keeps a second check on its own side, and the
engine runs in a contained plane.
"""

import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.request

_TICKET = "_gate_ticket"
_HERE = os.path.dirname(os.path.abspath(__file__))
_BLOCKED = "The gate did not allow this tool call, so it was not run."
_LOST_WRITE = "The connection to the gate was lost during this write. Its outcome is UNKNOWN. Do not retry it; say so."
_LOST_READ = "The gate could not be reached, so nothing was read."
# No proxy from the environment: the gate is reached directly or not at all.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# Decisions this process could not get, per session, cumulative and never cleared: a report that is
# lost must not take its count with it. A call blocked that way leaves Hermes no event and Backbone
# no record, so each turn reports the count; Backbone counts no turn done without it at zero.
_FAILED = {}


def _settings():
    with open(os.path.join(_HERE, "gate.json"), encoding="utf-8") as f:
        return json.load(f)


def _mac(key, kind, path, nonce, sent_at, body):
    return hmac.new(key, "\n".join([kind, path, nonce, sent_at, body]).encode("utf-8"), hashlib.sha256).hexdigest()


def _epoch(settings, timeout):
    """The gate's epoch, fresh at each start of the gate, asked with a fresh nonce. Taken only if the
    gate signs it over that nonce and a current time, under a key only the plane's secret gives: an
    impostor can neither hand one out nor get anything signed in return."""
    nonce = secrets.token_hex(16)
    request = urllib.request.Request(
        settings["url"] + "/epoch",
        data=json.dumps({"nonce": nonce}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with _OPENER.open(request, timeout=timeout) as response:
        text = response.read().decode("utf-8")
        given = response.headers.get("X-Gate-Mac") or ""
    reply = json.loads(text)
    epoch, at = reply.get("epoch"), reply.get("time")
    if not isinstance(epoch, str) or not epoch or not isinstance(at, int):
        raise ValueError("the gate gave no epoch")
    key = hmac.new(settings["token"].encode("utf-8"), b"hermes-gate-epoch", hashlib.sha256).digest()
    want = hmac.new(key, "\n".join(["epoch", nonce, epoch, str(at)]).encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(given, want) or abs(time.time() * 1000 - at) >= 60_000:
        raise ValueError("the gate did not prove its epoch")
    return epoch


def _post(path, payload, timeout):
    """One signed request. The plane's secret never leaves this process: the request carries a MAC
    under this turn's key for the gate's current epoch, with a fresh nonce and the time, and a reply
    that does not prove the same key is no reply at all."""
    settings = _settings()
    session = payload.get("session_id") if isinstance(payload.get("session_id"), str) else ""
    epoch = _epoch(settings, timeout)
    key = hmac.new(settings["token"].encode("utf-8"), "\n".join(["hermes-gate-turn", epoch, session]).encode("utf-8"), hashlib.sha256).digest()
    body = json.dumps(payload)
    nonce = secrets.token_hex(16)
    sent_at = str(int(time.time() * 1000))
    request = urllib.request.Request(
        settings["url"] + path,
        data=body.encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Gate-Nonce": nonce, "X-Gate-Time": sent_at, "X-Gate-Mac": _mac(key, "req", path, nonce, sent_at, body)},
        method="POST",
    )
    with _OPENER.open(request, timeout=timeout) as response:
        text = response.read().decode("utf-8")
        given = response.headers.get("X-Gate-Mac") or ""
    if not hmac.compare_digest(given, _mac(key, "res", path, nonce, sent_at, text)):
        raise ValueError("the gate did not prove it holds the key")
    reply = json.loads(text)
    if not isinstance(reply, dict):
        raise ValueError("the gate's reply is not an object")
    return reply


def pre_tool_call(tool_name=None, args=None, session_id="", tool_call_id="", turn_id="", **_):
    try:
        settings = _settings()
        reply = _post(
            "/decide",
            {"session_id": session_id, "tool_call_id": tool_call_id, "turn_id": turn_id, "tool_name": tool_name, "args": args},
            settings["decide_timeout_seconds"],
        )
    except Exception:
        _FAILED[session_id] = _FAILED.get(session_id, 0) + 1
        return {"action": "block", "message": _BLOCKED}
    if reply.get("action") == "allow":
        ticket = reply.get("ticket")
        return {"action": "modify", "args": {_TICKET: ticket}} if isinstance(ticket, str) and ticket else None
    message = reply.get("message")
    return {"action": "block", "message": message if isinstance(message, str) and message else _BLOCKED}


def post_llm_call(session_id="", **_):
    """Once per turn, after the tool loop: how many decisions this plugin could not get."""
    failed = _FAILED.get(session_id, 0)
    try:
        _post("/report", {"session_id": session_id, "failed": failed}, _settings()["decide_timeout_seconds"])
    except Exception:
        pass


def _door(tool_name, lost):
    def handle(args, session_id="", task_id="", **_):
        try:
            settings = _settings()
            plain = {k: v for k, v in args.items() if k != _TICKET}
            reply = _post(
                "/call",
                {"session_id": session_id or task_id, "ticket": args.get(_TICKET), "tool_name": tool_name, "args": plain},
                settings["call_timeout_seconds"],
            )
        except Exception:
            return json.dumps({"error": lost})
        try:
            # The answer is in hand. Backbone counts a call closed only on this; a lost one lowers the turn.
            if args.get(_TICKET):
                _post("/delivered", {"session_id": session_id or task_id, "ticket": args.get(_TICKET)}, settings["decide_timeout_seconds"])
        except Exception:
            pass
        text = reply.get("text") if isinstance(reply.get("text"), str) else lost
        return json.dumps({"output": text} if reply.get("ok") is True else {"error": text})

    return handle


def _tool(name, description, properties):
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": sorted(properties)},
    }


def register(ctx):
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    text = {"type": "string"}
    ctx.register_tool(
        name="door_list_files",
        toolset="door",
        schema=_tool("door_list_files", "List the project's files with their versions and class.", {}),
        handler=_door("door_list_files", _LOST_READ),
    )
    ctx.register_tool(
        name="door_read_file",
        toolset="door",
        schema=_tool("door_read_file", "Read the current version of a project file.", {"name": text}),
        handler=_door("door_read_file", _LOST_READ),
    )
    ctx.register_tool(
        name="door_write_file",
        toolset="door",
        schema=_tool(
            "door_write_file",
            "Write the whole text of a working document. The write is proposed through the effect gateway, which carries it.",
            {"name": text, "content": text},
        ),
        handler=_door("door_write_file", _LOST_WRITE),
    )
