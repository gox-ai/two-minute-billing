# Go 1.22+ (net/http)

Files: `billing/billing.go`, routes on the app's `http.ServeMux` in `main.go`. Standard library only.

## Client and webhook processing

```go
// billing/billing.go
package billing

import ("bytes"; "context"; "crypto/hmac"; "crypto/rand"; "crypto/sha256"; "database/sql"; "encoding/hex"
	"encoding/json"; "fmt"; "io"; "log"; "net/http"; "net/url"; "os"; "strconv"; "time")

var Prices = map[string]bool{"pro-monthly-usd": true, "pro-yearly-usd": true} // what the app sells
type Client struct{ BaseURL, APIKey, Biz string; HTTP *http.Client }
func FromEnv() *Client {
	return &Client{os.Getenv("TMBILLING_URL"), os.Getenv("TMBILLING_API_KEY"),
		os.Getenv("TMBILLING_BUSINESS_ID"), &http.Client{Timeout: 15 * time.Second}}
}
// Do calls the API. idemKey "" means a fresh key; pass the same key to retry one operation.
func (c *Client) Do(ctx context.Context, method, path string, body any, idemKey string, out any) error {
	var rd io.Reader
	if body != nil { b, _ := json.Marshal(body); rd = bytes.NewReader(b) }
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil { return err }
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	if method != http.MethodGet {
		if idemKey == "" { idemKey = NewUUID() }
		req.Header.Set("Idempotency-Key", idemKey)
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil { return err }
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("tmbilling %d: %.300s", res.StatusCode, b)
	}
	if out == nil { return nil }
	return json.NewDecoder(res.Body).Decode(out)
}
// Redirect creates a checkout or portal session and sends the browser to its url. Create one per
// click: a checkout link stays valid 24 h by default, a portal link 1 h and only once.
func (c *Client) Redirect(w http.ResponseWriter, r *http.Request, path string, body any) {
	var s struct{ URL string `json:"url"` }
	if err := c.Do(r.Context(), http.MethodPost, path, body, "", &s); err != nil || s.URL == "" {
		log.Printf("billing session %s: %v", path, err) // never log s.URL
		http.Error(w, "", http.StatusBadGateway); return
	}
	http.Redirect(w, r, s.URL, http.StatusSeeOther)
}
// Entitled checks a feature; required <= 0 omits the amount.
func (c *Client) Entitled(ctx context.Context, sub, key string, required int) (bool, error) {
	path := fmt.Sprintf("/v1/businesses/%s/subscriptions/%s/entitlements/%s/check", c.Biz, sub, url.PathEscape(key))
	if required > 0 { path += "?required=" + strconv.Itoa(required) }
	var r struct{ Entitled bool `json:"entitled"` } // also: reason, value, used
	err := c.Do(ctx, http.MethodGet, path, nil, "", &r); return r.Entitled, err
}
func NewUUID() string { // random v4
	b := make([]byte, 16); rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
type Event struct {
	ID         string                     `json:"id"`
	EventType  string                     `json:"event_type"`
	OccurredAt time.Time                  `json:"occurred_at"`
	Content    map[string]json.RawMessage `json:"content"`
}
func Verify(raw []byte, header, secret string) bool {
	mac := hmac.New(sha256.New, []byte(secret)); mac.Write(raw)
	return hmac.Equal([]byte("sha256="+hex.EncodeToString(mac.Sum(nil))), []byte(header))
}
// ProcessOnce commits the event id and its effects together; an error rolls both back.
func (c *Client) ProcessOnce(ctx context.Context, db *sql.DB, ev Event) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil { return err }
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `INSERT INTO billing_events (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, ev.ID)
	if err != nil { return err }
	if n, _ := res.RowsAffected(); n == 1 {
		if err := c.apply(ctx, tx, ev); err != nil { return err }
	}
	return tx.Commit()
}
// Content is a short summary (ids, status, a few fields); fetch the resource for the rest.
func (c *Client) apply(ctx context.Context, tx *sql.Tx, ev Event) error {
	var ref struct{ ID string `json:"id"` }
	switch ev.EventType {
	case "subscription_created", "subscription_changed", "subscription_canceled":
		if err := json.Unmarshal(ev.Content["subscription"], &ref); err != nil { return err }
		var sub struct {
			ID, Status, Customer string
			Metadata             map[string]any
		}
		if err := c.Do(ctx, http.MethodGet, "/v1/businesses/"+c.Biz+"/subscriptions/"+ref.ID, nil, "", &sub); err != nil { return err }
		accountID, _ := sub.Metadata["app_account_id"].(string) // set at checkout
		if accountID == "" { return nil }
		_, err := tx.ExecContext(ctx, `UPDATE accounts SET tmbilling_customer_id = $2,
			tmbilling_subscription_id = $3, billing_status = $4, billing_synced_at = $5
			WHERE id = $1 AND (billing_synced_at IS NULL OR billing_synced_at < $5)`, // older never overwrites newer
			accountID, sub.Customer, sub.ID, sub.Status, ev.OccurredAt)
		return err
	case "invoice_paid":
		if err := json.Unmarshal(ev.Content["invoice"], &ref); err != nil { return err }
		var inv struct {
			Status   string
			Metadata map[string]any // one-time store: Metadata["order_id"] is the order
		}
		if err := c.Do(ctx, http.MethodGet, "/v1/businesses/"+c.Biz+"/invoices/"+ref.ID, nil, "", &inv); err != nil { return err }
		if inv.Status == "paid" { /* record the receipt */ }
	case "payment_failed": // no fetch: content.payment has amount_minor, currency, invoice, code, message
	default:
		log.Printf("billing webhook: skipped %s", ev.EventType) // new types appear; never fail
	}
	return nil
}
```

## Routes

```go
tmb, appURL, secret := billing.FromEnv(), os.Getenv("APP_URL"), os.Getenv("TMBILLING_WEBHOOK_SECRET")

mux.HandleFunc("POST /billing/subscribe", func(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r) // placeholder: replace with the app's auth
	if !ok { http.Error(w, "", http.StatusUnauthorized); return }
	price := r.PostFormValue("price")
	if !billing.Prices[price] { http.Error(w, "Unknown price", http.StatusBadRequest); return }
	tmb.Redirect(w, r, "/v1/businesses/"+tmb.Biz+"/checkout_sessions", map[string]any{
		"items":        []map[string]any{{"price": price, "quantity": 1}},
		"customer":     map[string]string{"email": user.Email},
		"metadata":     map[string]string{"app_account_id": user.AccountID}, // lands on the subscription
		"redirect_url": appURL + "/billing/done", // shows "processing"; the webhook grants access
		"cancel_url":   appURL + "/pricing",
	})
})
mux.HandleFunc("POST /billing/manage", func(w http.ResponseWriter, r *http.Request) {
	user, ok := currentUser(r)
	if !ok { http.Error(w, "", http.StatusUnauthorized); return }
	if user.TmbillingCustomerID == "" { http.Redirect(w, r, "/pricing", http.StatusSeeOther); return }
	tmb.Redirect(w, r, "/v1/businesses/"+tmb.Biz+"/customers/"+user.TmbillingCustomerID+"/portal_sessions", map[string]any{})
})
mux.HandleFunc("POST /webhooks/billing", func(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20)) // the exact signed bytes
	if err != nil { w.WriteHeader(http.StatusRequestEntityTooLarge); return }
	if !billing.Verify(raw, r.Header.Get("Tmbilling-Signature"), secret) { w.WriteHeader(http.StatusUnauthorized); return }
	var ev billing.Event
	if err := json.Unmarshal(raw, &ev); err != nil { w.WriteHeader(http.StatusBadRequest); return }
	if err := tmb.ProcessOnce(r.Context(), db, ev); err != nil { // 500: the event comes again
		log.Printf("billing webhook %s: %v", ev.ID, err); w.WriteHeader(http.StatusInternalServerError); return
	}
	w.WriteHeader(http.StatusOK)
})
```

## Gotchas

- Method patterns (`"POST /path"`) need `go 1.22`+ in `go.mod`; else they match as literal paths.
- Middleware that reads `r.Body` (logging) must put the bytes back, or the handler hashes nothing.
- `hmac.Equal` is constant-time; never compare the hex strings with `==`. Token-based CSRF
  middleware (`gorilla/csrf`) must exempt `/webhooks/billing`.
- Submit with a form, not `fetch()`: `fetch` follows the 303 silently instead of navigating.
