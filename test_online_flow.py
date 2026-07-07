#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Quick integration test for online room flow (MULTIPLAYER_GUIDE framework)."""
import asyncio
import json
import sys
import uuid

try:
    import websockets
except ImportError:
    print("pip install websockets")
    sys.exit(1)

URL = "ws://127.0.0.1:8080/ws"
ROOM = None


def cid():
    return "test_" + uuid.uuid4().hex[:12]


async def test_flow():
    global ROOM
    host_id = cid()
    guest_id = cid()

    async with websockets.connect(URL) as host:
        await host.send(json.dumps({"type": "create", "clientId": host_id}))
        created = json.loads(await host.recv())
        assert created["type"] == "created", created
        ROOM = created["code"]
        print(f"[OK] host created room {ROOM}")

        async with websockets.connect(URL) as guest:
            await guest.send(json.dumps({
                "type": "join", "code": ROOM, "clientId": guest_id,
            }))
            joined = json.loads(await guest.recv())
            assert joined["type"] == "joined", joined
            print("[OK] guest joined")

            peer = json.loads(await host.recv())
            assert peer["type"] == "peer_joined", peer
            print("[OK] host received peer_joined")

            await host.send(json.dumps({
                "type": "relay",
                "payload": {"type": "board_setup", "board": {"obstacles": []}},
            }))
            msg = json.loads(await guest.recv())
            assert msg.get("type") == "board_setup", msg
            print("[OK] board_setup relayed to guest")

    async with websockets.connect(URL) as host2:
        host2_id = cid()
        await host2.send(json.dumps({"type": "create", "clientId": host2_id}))
        code = json.loads(await host2.recv())["code"]
        await host2.send(json.dumps({
            "type": "relay",
            "payload": {"type": "board_setup", "board": {}},
        }))
        err = json.loads(await host2.recv())
        assert err.get("type") == "error", err
        print(f"[OK] blocked start without guest: {err.get('message')}")

    async with websockets.connect(URL) as host3:
        resume_id = cid()
        await host3.send(json.dumps({"type": "create", "clientId": resume_id}))
        code3 = json.loads(await host3.recv())["code"]

    await asyncio.sleep(0.1)

    async with websockets.connect(URL) as host3b:
        await host3b.send(json.dumps({"type": "hello", "code": code3, "clientId": resume_id}))
        resumed = json.loads(await host3b.recv())
        assert resumed["type"] == "resumed", resumed
        print("[OK] hello resume works")

    print("\nAll online flow checks passed.")


if __name__ == "__main__":
    asyncio.run(test_flow())
