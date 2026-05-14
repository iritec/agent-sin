"""Builtin: todo-tick

memory.todo namespace の open ToDo を走査し、due が現在時刻に達したものを
ctx.notify で通知する。重複通知を避けるため notified_at を打つ。
同じ期限時刻(分単位)のToDoは1通にまとめて通知する。

入力:
  args.channel: 通知チャネル (auto/macos/discord/telegram/slack/mail/stderr, default: auto)
出力:
  data.fired:   通知したToDoの配列
  data.pending: 未通知のopen ToDo件数(due未設定 or 未到達も含む)
"""

from __future__ import annotations

import os
import sys
from collections import OrderedDict
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    channel = str(args.get("channel", "auto")).strip() or "auto"

    items = list((await ctx.memory.get("items")) or [])
    if not items:
        return result_ok(loc.t("Nothing due", "対象なし"), loc.t("There are no ToDos.", "ToDoはありません"), [], 0)

    now_str = input.get("trigger", {}).get("time")
    now = parse_iso(now_str) or datetime.now(timezone.utc)

    # 同じ期限(分単位)のToDoをまとめて1通にする
    groups: "OrderedDict[str, list]" = OrderedDict()
    for item in items:
        if item.get("status") != "open":
            continue
        if item.get("notified_at"):
            continue
        due = parse_iso(item.get("due"))
        if not due or due > now:
            continue
        key = due.replace(second=0, microsecond=0).isoformat()
        groups.setdefault(key, []).append(item)

    fired = []
    failed = []
    for group in groups.values():
        body = "\n".join(i.get("text", "ToDo") for i in group)
        outcome = await ctx.notify({
            "title": loc.t("ToDo due", "ToDoの期限"),
            "body": body,
            "channel": channel,
        })
        if outcome.get("ok"):
            stamp = now.isoformat()
            for item in group:
                item["notified_at"] = stamp
                fired.append(item)
                ctx.log.info(f"todo-tick: fired id={item.get('id')}")
        else:
            detail = outcome.get("detail") or "unknown"
            for item in group:
                failed.append({"id": item.get("id"), "error": detail})
                ctx.log.warn(f"todo-tick: notify failed id={item.get('id')} - {detail}")

    if fired:
        await ctx.memory.set("items", items)

    pending = sum(
        1 for i in items
        if i.get("status") == "open" and not i.get("notified_at")
    )

    if not fired and not failed:
        return result_ok(loc.t("No notifications", "通知なし"), loc.t("No ToDos are due.", "期限到達のToDoはありません"), [], pending)
    if failed and not fired:
        return {
            "status": "error",
            "title": loc.t("Notification failed", "通知に失敗しました"),
            "summary": loc.t(f"{len(failed)} notifications failed.", f"{len(failed)}件の通知に失敗しました"),
            "outputs": {},
            "data": {"fired": [], "failed": failed, "pending": pending},
            "suggestions": [],
        }

    title = loc.t(f"Sent {len(fired)} notifications", f"{len(fired)}件を通知しました")
    lines = [f"- {i.get('text', '')}" for i in fired]
    if failed:
        lines.append(loc.t(f"({len(failed)} failed)", f"(失敗 {len(failed)}件)"))
    return {
        "status": "ok",
        "title": title,
        "summary": "\n".join(lines),
        "outputs": {},
        "data": {"fired": fired, "failed": failed, "pending": pending},
        "suggestions": [],
    }


def parse_iso(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def result_ok(title, summary, fired, pending):
    return {
        "status": "ok",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {"fired": fired, "pending": pending},
        "suggestions": [],
    }
