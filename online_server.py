#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""弹棋问机 · 联机中继（房间号转发，不跑物理）"""
import asyncio
import json
import random
import socket
import string
import subprocess
import sys
import time

PORT = 8765
rooms = {}


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return False
        except OSError:
            return True


def find_listening_pids(port: int) -> list[int]:
    if sys.platform != "win32":
        return []
    try:
        out = subprocess.check_output(
            ["netstat", "-ano"],
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    pids = []
    suffix = f":{port}"
    for line in out.splitlines():
        if "LISTENING" not in line or suffix not in line:
            continue
        parts = line.split()
        if len(parts) >= 5 and parts[-1].isdigit():
            pid = int(parts[-1])
            if pid not in pids:
                pids.append(pid)
    return pids


def print_port_busy_help(port: int) -> None:
    pids = find_listening_pids(port)
    print(f"\n错误：端口 {port} 已被占用，无法启动联机中继。")
    print("常见原因：已有一个 online-server.bat 窗口在运行。")
    if pids:
        print(f"当前占用进程 PID：{', '.join(str(p) for p in pids)}")
    print("\n解决办法（任选其一）：")
    print("  1. 找到之前的中继黑窗口，按 Ctrl+C 关闭后再运行本脚本")
    print("  2. 重新双击 online-server.bat（会自动结束旧中继）")
    if pids:
        print(f"  3. 手动结束：taskkill /PID {pids[0]} /F")
    print()


def is_ws_open(ws) -> bool:
    if ws is None:
        return False
    closed = getattr(ws, "closed", None)
    if closed is not None:
        return not closed
    state = getattr(ws, "state", None)
    if state is not None:
        try:
            from websockets.protocol import State
            return state == State.OPEN
        except ImportError:
            pass
    return True


def ensure_port_free(port: int) -> None:
    if not port_in_use(port):
        return
    if "--force" in sys.argv:
        for pid in find_listening_pids(port):
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/F"],
                    check=False,
                    capture_output=True,
                )
        time.sleep(0.6)
        if not port_in_use(port):
            print(f"已结束占用端口 {port} 的旧进程。", flush=True)
            return
    print_port_busy_help(port)
    raise SystemExit(1)


def new_code():
    for _ in range(200):
        code = "".join(random.choices(string.digits, k=6))
        if code not in rooms:
            return code
    raise RuntimeError("no room codes")


async def relay(room, sender_role, payload):
    target_role = "guest" if sender_role == "host" else "host"
    peer = room.get(target_role)
    if peer and is_ws_open(peer):
        await peer.send(json.dumps(payload, ensure_ascii=False))


async def ws_handler(ws):
    room_code = None
    role = None
    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send(json.dumps({"type": "error", "message": "无效 JSON"}))
                continue

            msg_type = data.get("type")

            if msg_type == "create":
                code = new_code()
                rooms[code] = {"host": ws, "guest": None}
                room_code, role = code, "host"
                await ws.send(json.dumps({"type": "created", "code": code}))
                continue

            if msg_type == "join":
                code = str(data.get("code", "")).strip()
                room = rooms.get(code)
                if not room or room["guest"] is not None:
                    await ws.send(json.dumps({"type": "error", "message": "房间不存在或已满"}))
                    continue
                room["guest"] = ws
                room_code, role = code, "guest"
                await ws.send(json.dumps({"type": "joined", "code": code, "role": "guest"}))
                host = room["host"]
                if host and is_ws_open(host):
                    await host.send(json.dumps({"type": "peer_joined"}))
                continue

            if not room_code or room_code not in rooms:
                await ws.send(json.dumps({"type": "error", "message": "未加入房间"}))
                continue

            room = rooms[room_code]
            if role == "host" and msg_type == "relay":
                payload = data.get("payload") or {}
                if payload.get("type") == "board_setup" and not room.get("guest"):
                    await ws.send(json.dumps({
                        "type": "error",
                        "message": "对方尚未加入，无法开始",
                    }))
                    continue
                await relay(room, "host", payload)
            elif role == "guest" and msg_type == "relay":
                await relay(room, "guest", data.get("payload") or {})
            else:
                await relay(room, role, data)
    finally:
        if room_code and room_code in rooms:
            room = rooms[room_code]
            if role == "host":
                guest = room.get("guest")
                if guest and is_ws_open(guest):
                    await guest.close()
                del rooms[room_code]
            elif role == "guest":
                room["guest"] = None
                host = room.get("host")
                if host and is_ws_open(host):
                    try:
                        await host.send(json.dumps({"type": "peer_left"}))
                    except Exception:
                        pass


async def main():
    try:
        import websockets
    except ImportError:
        print("请先安装: pip install websockets")
        raise SystemExit(1)

    ensure_port_free(PORT)

    print(f"联机中继 ws://127.0.0.1:{PORT}/", flush=True)
    print("与 serve.bat 同时运行；局域网请放行此端口。", flush=True)
    print("按 Ctrl+C 停止。\n", flush=True)
    async with websockets.serve(ws_handler, "0.0.0.0", PORT, ping_interval=20, ping_timeout=60):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
