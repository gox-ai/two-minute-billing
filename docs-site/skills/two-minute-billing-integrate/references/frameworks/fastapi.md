# FastAPI

Files: `app/billing/client.py` (REST client + verify), `app/billing/routes.py` (an `APIRouter`
included in `main.py`). There is no Python SDK; call the REST API with `httpx`.

## Client

```python
# app/billing/client.py
import hashlib, hmac, os, uuid
from urllib.parse import quote
import httpx

BIZ = os.environ["TMBILLING_BUSINESS_ID"]
APP_URL = os.environ["APP_URL"]
WEBHOOK_SECRET = os.environ["TMBILLING_WEBHOOK_SECRET"]
PRICES = {"pro-monthly-usd", "pro-yearly-usd"}  # what the app sells

http = httpx.AsyncClient(
    base_url=os.environ["TMBILLING_URL"],
    headers={"Authorization": f"Bearer {os.environ['TMBILLING_API_KEY']}"},
    timeout=15,
)  # close it in the app's lifespan

class TmbillingError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"tmbilling {status}: {body[:300]}")
        self.status, self.body = status, body

async def api(method: str, path: str, body: dict | None = None, idempotency_key: str | None = None) -> dict:
    headers = {}
    if method != "GET":  # pass the same key to retry one operation
        headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
    res = await http.request(method, path, json=body, headers=headers)  # json= sets Content-Type
    if res.is_error:
        raise TmbillingError(res.status_code, res.text)
    return res.json()

def verify(raw: bytes, header: str | None) -> bool:
    if not header:
        return False
    expected = "sha256=" + hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)

async def entitled(sub: str, key: str, required: int | None = None) -> bool:
    path = f"/v1/businesses/{BIZ}/subscriptions/{sub}/entitlements/{quote(key, safe='')}/check"
    if required is not None:
        path += f"?required={required}"
    return (await api("GET", path))["entitled"]  # also: reason, value, used
```

## Routes

```python
# app/billing/routes.py
import json, logging
from typing import Annotated
from fastapi import APIRouter, Depends, Form, Header, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import text
from app.auth import User, current_user  # replace with the app's auth
from app.db import SessionLocal  # the app's async SQLAlchemy sessionmaker
from .client import APP_URL, BIZ, PRICES, api, verify

router = APIRouter()
log = logging.getLogger(__name__)

@router.post("/billing/subscribe")
async def subscribe(price: Annotated[str, Form()], user: Annotated[User, Depends(current_user)]):
    if price not in PRICES:
        raise HTTPException(400, "Unknown price")
    session = await api("POST", f"/v1/businesses/{BIZ}/checkout_sessions", {
        "items": [{"price": price, "quantity": 1}],
        "customer": {"email": user.email},
        "metadata": {"app_account_id": str(user.account_id)},  # lands on the subscription
        "redirect_url": f"{APP_URL}/billing/done",  # shows "processing"; the webhook grants access
        "cancel_url": f"{APP_URL}/pricing",
    })
    return RedirectResponse(session["url"], status_code=303)  # valid 24 h by default: create it per click, never log it

@router.post("/billing/manage")
async def manage(user: Annotated[User, Depends(current_user)]):
    if not user.tmbilling_customer_id:
        return RedirectResponse("/pricing", status_code=303)
    portal = await api("POST", f"/v1/businesses/{BIZ}/customers/{user.tmbilling_customer_id}/portal_sessions", {})
    return RedirectResponse(portal["url"], status_code=303)

@router.post("/webhooks/billing")
async def billing_webhook(request: Request, tmbilling_signature: Annotated[str | None, Header()] = None):
    raw = await request.body()  # the exact signed bytes
    if not verify(raw, tmbilling_signature):
        return Response(status_code=401)
    event = json.loads(raw)
    # Event id (= Tmbilling-Event-Id header) and its effects commit together.
    async with SessionLocal() as db, db.begin():
        ins = await db.execute(
            text("INSERT INTO billing_events (id) VALUES (:id) ON CONFLICT (id) DO NOTHING"),
            {"id": event["id"]})
        if ins.rowcount == 1:
            await apply(db, event)
    return Response(status_code=200)  # an exception above is a 500, and the event comes again

# content is a short summary (ids, status, a few fields); fetch the resource for the rest.
async def apply(db, event: dict) -> None:
    kind, content = event["event_type"], event["content"]
    if kind in ("subscription_created", "subscription_changed", "subscription_canceled"):
        sub = await api("GET", f"/v1/businesses/{BIZ}/subscriptions/{content['subscription']['id']}")
        account_id = (sub.get("metadata") or {}).get("app_account_id")  # set at checkout
        if not account_id:
            return
        await db.execute(text(  # an older event never overwrites newer state
            """UPDATE accounts SET tmbilling_customer_id = :cus, tmbilling_subscription_id = :sub,
                 billing_status = :status, billing_synced_at = CAST(:at AS timestamptz)
               WHERE id = :account AND (billing_synced_at IS NULL
                 OR billing_synced_at < CAST(:at AS timestamptz))"""),
            {"account": account_id, "cus": sub["customer"], "sub": sub["id"],
             "status": sub["status"], "at": event["occurred_at"]})
    elif kind == "invoice_paid":
        inv = await api("GET", f"/v1/businesses/{BIZ}/invoices/{content['invoice']['id']}")
        if inv["status"] == "paid":
            pass  # record the receipt; one-time store: (inv.get("metadata") or {}).get("order_id") is the order
    elif kind == "payment_failed":
        pass  # no fetch: content["payment"] has amount_minor, currency, invoice, code, message
    else:
        log.info("billing webhook: skipped %s", kind)  # new types appear; never raise
```

## Gotchas

- Do not declare the webhook body as a Pydantic model or `dict` parameter: FastAPI parses it, and
  a re-serialized dict is not the signed bytes. Take `Request` and call `await request.body()`.
- `Form()` needs the `python-multipart` package; without it the app fails at startup.
- `Header()` maps `tmbilling_signature` to the `tmbilling-signature` header. Behind a proxy, check
  that it forwards both `Tmbilling-*` headers unchanged.
- A sync DB driver inside an `async def` route blocks the event loop. Use an async driver, or make
  the route a plain `def` so it runs in the thread pool.
- Submit with a form, not `fetch()`: `fetch` follows the 303 silently instead of navigating.
