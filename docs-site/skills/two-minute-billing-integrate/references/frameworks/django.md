# Django 5

Files: a `billing` app — `billing/client.py` (REST client + verify), `billing/models.py`,
`billing/views.py`, `billing/urls.py` included from the project `urls.py`. There is no Python SDK;
call the REST API with `httpx` (or `requests`).

## Client

```python
# billing/client.py
import hashlib, hmac, os, uuid
from urllib.parse import quote
import httpx

BIZ = os.environ["TMBILLING_BUSINESS_ID"]
APP_URL = os.environ["APP_URL"]
PRICES = {"pro-monthly-usd", "pro-yearly-usd"}  # what the app sells

_http = httpx.Client(
    base_url=os.environ["TMBILLING_URL"],
    headers={"Authorization": f"Bearer {os.environ['TMBILLING_API_KEY']}"},
    timeout=15,
)

class TmbillingError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"tmbilling {status}: {body[:300]}")
        self.status, self.body = status, body

def api(method: str, path: str, body: dict | None = None, idempotency_key: str | None = None) -> dict:
    headers = {}
    if method != "GET":  # pass the same key to retry one operation
        headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
    res = _http.request(method, path, json=body, headers=headers)  # json= sets Content-Type
    if res.is_error:
        raise TmbillingError(res.status_code, res.text)
    return res.json()

def verify(raw: bytes, header: str | None) -> bool:
    if not header:
        return False
    secret = os.environ["TMBILLING_WEBHOOK_SECRET"].encode()
    expected = "sha256=" + hmac.new(secret, raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)

def entitled(sub: str, key: str, required: int | None = None) -> bool:
    path = f"/v1/businesses/{BIZ}/subscriptions/{sub}/entitlements/{quote(key, safe='')}/check"
    if required is not None:
        path += f"?required={required}"
    return api("GET", path)["entitled"]  # also: reason, value, used
```

## Views

```python
# billing/views.py
import json, logging
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse, HttpResponseBadRequest, HttpResponseRedirect
from django.utils.dateparse import parse_datetime
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from accounts.models import Account  # the app's account model
from .client import APP_URL, BIZ, PRICES, api, verify
from .models import BillingEvent  # event_id = models.CharField(max_length=64, unique=True)

log = logging.getLogger(__name__)

class HttpResponseSeeOther(HttpResponseRedirect):
    status_code = 303

@login_required  # replace with the app's auth if it differs
@require_POST
def subscribe(request):
    price = request.POST.get("price", "")
    if price not in PRICES:
        return HttpResponseBadRequest("Unknown price")
    account = request.user.account
    session = api("POST", f"/v1/businesses/{BIZ}/checkout_sessions", {
        "items": [{"price": price, "quantity": 1}],
        "customer": {"email": request.user.email},
        "metadata": {"app_account_id": str(account.pk)},  # lands on the subscription
        "redirect_url": f"{APP_URL}/billing/done",  # shows "processing"; the webhook grants access
        "cancel_url": f"{APP_URL}/pricing",
    })
    return HttpResponseSeeOther(session["url"])  # valid 24 h by default: create it per click, never store or log it

@login_required
@require_POST
def manage(request):
    cus = request.user.account.tmbilling_customer_id
    if not cus:
        return HttpResponseSeeOther("/pricing")
    portal = api("POST", f"/v1/businesses/{BIZ}/customers/{cus}/portal_sessions", {})
    return HttpResponseSeeOther(portal["url"])

@csrf_exempt  # outermost, so the flag lands on the final view
@require_POST
def billing_webhook(request):
    raw = request.body  # the exact signed bytes
    if not verify(raw, request.headers.get("Tmbilling-Signature")):
        return HttpResponse(status=401)
    event = json.loads(raw)
    with transaction.atomic():  # event id and its effects commit together
        _, created = BillingEvent.objects.get_or_create(event_id=event["id"])
        if created:
            apply(event)
    return HttpResponse(status=200)  # an exception above is a 500, and the event comes again

# content is a short summary (ids, status, a few fields); fetch the resource for the rest.
def apply(event: dict) -> None:
    kind, content = event["event_type"], event["content"]
    if kind in ("subscription_created", "subscription_changed", "subscription_canceled"):
        sub = api("GET", f"/v1/businesses/{BIZ}/subscriptions/{content['subscription']['id']}")
        account_id = (sub.get("metadata") or {}).get("app_account_id")  # set at checkout
        if not account_id:
            return
        at = parse_datetime(event["occurred_at"])
        Account.objects.filter(pk=account_id).filter(  # an older event never overwrites newer state
            Q(billing_synced_at__isnull=True) | Q(billing_synced_at__lt=at)
        ).update(tmbilling_customer_id=sub["customer"], tmbilling_subscription_id=sub["id"],
                 billing_status=sub["status"], billing_synced_at=at)
    elif kind == "invoice_paid":
        inv = api("GET", f"/v1/businesses/{BIZ}/invoices/{content['invoice']['id']}")
        if inv["status"] == "paid":
            pass  # record the receipt; one-time store: (inv.get("metadata") or {}).get("order_id") is the order
    elif kind == "payment_failed":
        pass  # no fetch: content["payment"] has amount_minor, currency, invoice, code, message
    else:
        log.info("billing webhook: skipped %s", kind)  # new types appear; never raise
```

```python
# billing/urls.py
urlpatterns = [path("billing/subscribe", views.subscribe), path("billing/manage", views.manage),
               path("webhooks/billing", views.billing_webhook)]
```

## Gotchas

- Keep CSRF on `subscribe` and `manage` (`{% csrf_token %}` in the form); exempt only the webhook.
- `request.body` can be read only before the stream is consumed. Middleware that touches
  `request.POST` on a multipart request makes `request.body` raise `RawPostDataException`.
- `APPEND_SLASH`: a POST to `webhooks/billing/` when the pattern has no slash (or the reverse)
  cannot be redirected. Register the exact URL the pattern serves.
- Bodies over `DATA_UPLOAD_MAX_MEMORY_SIZE` (2.5 MB default) raise `RequestDataTooBig`; keep the
  default or raise it, never disable it.
- Submit with a form, not `fetch()`: `fetch` follows the 303 silently instead of navigating.
