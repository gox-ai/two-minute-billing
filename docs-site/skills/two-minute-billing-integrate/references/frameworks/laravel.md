# Laravel 12

Files: `config/services.php`, `app/Billing/Tmbilling.php` (REST client + verify),
`app/Http/Controllers/BillingController.php`, `routes/web.php`, CSRF exception in
`bootstrap/app.php`. There is no PHP SDK; use the `Http` client.

## Config and client

```php
// config/services.php — add to the returned array
'tmbilling' => ['url' => env('TMBILLING_URL'), 'key' => env('TMBILLING_API_KEY'),
    'business' => env('TMBILLING_BUSINESS_ID'), 'webhook_secret' => env('TMBILLING_WEBHOOK_SECRET')],
```

```php
<?php // app/Billing/Tmbilling.php
namespace App\Billing;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\{DB, Http, Log};
use Illuminate\Support\Str;

class Tmbilling
{
    public const PRICES = ['pro-monthly-usd', 'pro-yearly-usd']; // what the app sells
    public static function biz(): string { return config('services.tmbilling.business'); }

    // Pass the same $idempotencyKey to retry one operation. Throws RequestException on 4xx/5xx.
    public static function post(string $path, array $body = [], ?string $idempotencyKey = null): array
    {
        return Http::withToken(config('services.tmbilling.key'))->timeout(15)
            ->withHeaders(['Idempotency-Key' => $idempotencyKey ?? (string) Str::uuid()])
            ->withBody($body ? json_encode($body) : '{}', 'application/json') // [] would encode as a list
            ->post(config('services.tmbilling.url').$path)
            ->throw()->json();
    }

    public static function entitled(string $sub, string $key, ?int $required = null): bool
    {
        $path = '/v1/businesses/'.self::biz()."/subscriptions/{$sub}/entitlements/".rawurlencode($key).'/check';
        return Http::withToken(config('services.tmbilling.key'))->timeout(15)
            ->get(config('services.tmbilling.url').$path, $required === null ? [] : ['required' => $required])
            ->throw()->json('entitled'); // also: reason, value, used
    }

    public static function validSignature(string $raw, ?string $header): bool
    {
        $expected = 'sha256='.hash_hmac('sha256', $raw, config('services.tmbilling.webhook_secret'));
        return is_string($header) && hash_equals($expected, $header);
    }

    public static function get(string $path): array
    {
        return Http::withToken(config('services.tmbilling.key'))->timeout(15)
            ->get(config('services.tmbilling.url').$path)->throw()->json();
    }

    // content is a short summary (ids, status, a few fields); fetch the resource for the rest.
    public static function apply(array $event): void
    {
        $content = $event['content'];
        switch ($event['event_type']) {
            case 'subscription_created':
            case 'subscription_changed':
            case 'subscription_canceled':
            case 'subscription_activated':
            case 'subscription_cancel_scheduled':
            case 'subscription_scheduled_cancellation_removed':
            case 'subscription_reactivated':
            case 'subscription_paused':
            case 'subscription_resumed':
                $sub = self::get('/v1/businesses/'.self::biz().'/subscriptions/'.$content['subscription']['id']);
                $accountId = $sub['metadata']['app_account_id'] ?? null; // set at checkout
                if (! $accountId) return;
                $at = Carbon::parse($event['occurred_at']);
                DB::table('accounts')->where('id', $accountId) // an older event never overwrites newer state
                    ->where(fn ($q) => $q->whereNull('billing_synced_at')->orWhere('billing_synced_at', '<', $at))
                    ->update(['tmbilling_customer_id' => $sub['customer'], 'tmbilling_subscription_id' => $sub['id'],
                              'billing_status' => $sub['status'], 'billing_synced_at' => $at]);
                return;
            case 'invoice_paid':
                $inv = self::get('/v1/businesses/'.self::biz().'/invoices/'.$content['invoice']['id']);
                if ($inv['status'] === 'paid') {
                    // Record the receipt. One-time store: $inv['metadata']['order_id'] ?? null is the order.
                }
                return;
            case 'payment_failed': return; // no fetch: $content['payment'] has amount_minor, currency, invoice, code, message
            default: Log::info('billing webhook: skipped '.$event['event_type']); // never throw
        }
    }
}
```

## Controller and routes

```php
<?php // app/Http/Controllers/BillingController.php
namespace App\Http\Controllers;

use App\Billing\Tmbilling;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class BillingController extends Controller
{
    public function subscribe(Request $request)
    {
        $price = $request->validate(['price' => ['required', Rule::in(Tmbilling::PRICES)]])['price'];
        $user = $request->user();
        $session = Tmbilling::post('/v1/businesses/'.Tmbilling::biz().'/checkout_sessions', [
            'items' => [['price' => $price, 'quantity' => 1]],
            'customer' => ['email' => $user->email],
            'metadata' => ['app_account_id' => (string) $user->account_id], // lands on the subscription
            'redirect_url' => config('app.url').'/billing/done', // shows "processing"; the webhook grants access
            'cancel_url' => config('app.url').'/pricing', // config('app.url') reads APP_URL
        ]);
        return redirect()->away($session['url'], 303); // valid 24 h by default: create it per click, never store or log it
    }

    public function manage(Request $request)
    {
        $cus = $request->user()->account->tmbilling_customer_id;
        if (! $cus) return redirect('/pricing', 303);
        $portal = Tmbilling::post('/v1/businesses/'.Tmbilling::biz()."/customers/{$cus}/portal_sessions");
        return redirect()->away($portal['url'], 303);
    }

    public function webhook(Request $request)
    {
        $raw = $request->getContent(); // the exact signed bytes
        if (! Tmbilling::validSignature($raw, $request->header('Tmbilling-Signature'))) return response('', 401);
        $event = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        DB::transaction(function () use ($event) { // event id and its effects commit together
            $fresh = DB::table('billing_events')->insertOrIgnore(['event_id' => $event['id'], 'created_at' => now()]);
            if ($fresh === 1) Tmbilling::apply($event); // billing_events.event_id has a unique index
        });
        return response('', 200); // an exception above is a 500, and the event comes again
    }
}
```

```php
// routes/web.php
use App\Http\Controllers\BillingController;

Route::middleware('auth')->group(function () { // replace with the app's auth
    Route::post('/billing/subscribe', [BillingController::class, 'subscribe']);
    Route::post('/billing/manage', [BillingController::class, 'manage']);
});
Route::post('/webhooks/billing', [BillingController::class, 'webhook']); // outside the auth group

// bootstrap/app.php
->withMiddleware(function (Middleware $middleware) {
    $middleware->validateCsrfTokens(except: ['webhooks/billing']);
})
```

## Gotchas

- With `php artisan config:cache`, `env()` returns null outside config files. Read values only
  through `config('services.tmbilling.*')`.
- Without the CSRF exception, every delivery gets `419`. Keep CSRF on subscribe and manage.
- Inertia forms submit by XHR and cannot follow an external redirect. Return
  `Inertia::location($session['url'])` from those routes instead of `redirect()->away()`.
- `$request->getContent()` is the raw body; `TrimStrings` and other input middleware do not
  change it. Never rebuild it from `$request->all()`.
- `routes/api.php` (after `php artisan install:api`) has no CSRF; the webhook may live there instead.
