# Rails 8

Files: `app/services/billing.rb` (REST client + verify), `app/controllers/billing_controller.rb`,
`app/controllers/billing_webhooks_controller.rb`, routes in `config/routes.rb`. There is no Ruby
SDK; call the REST API with `Net::HTTP` (or Faraday).

## Client

```ruby
# app/services/billing.rb
require "net/http"

module Billing
  BIZ = ENV.fetch("TMBILLING_BUSINESS_ID")
  PRICES = %w[pro-monthly-usd pro-yearly-usd].freeze # what the app sells
  class Error < StandardError
    attr_reader :status, :body
    def initialize(status, body)
      @status, @body = status, body
      super("tmbilling #{status}")
    end
  end

  module_function

  # Pass the same idempotency_key to retry one operation.
  def request(method, path, body = nil, idempotency_key: nil)
    uri = URI(ENV.fetch("TMBILLING_URL") + path)
    req = (method == :get ? Net::HTTP::Get : Net::HTTP::Post).new(uri)
    req["Authorization"] = "Bearer #{ENV.fetch("TMBILLING_API_KEY")}"
    unless method == :get
      req["Idempotency-Key"] = idempotency_key || SecureRandom.uuid
      req["Content-Type"] = "application/json"
      req.body = (body || {}).to_json
    end
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                          open_timeout: 5, read_timeout: 15) { |http| http.request(req) }
    raise Error.new(res.code.to_i, res.body) unless res.is_a?(Net::HTTPSuccess)
    JSON.parse(res.body)
  end

  def valid_signature?(raw, header)
    expected = "sha256=" + OpenSSL::HMAC.hexdigest("SHA256", ENV.fetch("TMBILLING_WEBHOOK_SECRET"), raw)
    header.present? && ActiveSupport::SecurityUtils.secure_compare(expected, header)
  end

  def entitled?(sub, key, required = nil)
    path = "/v1/businesses/#{BIZ}/subscriptions/#{sub}/entitlements/#{ERB::Util.url_encode(key)}/check"
    path += "?required=#{required.to_i}" if required
    request(:get, path).fetch("entitled") # also: reason, value, used
  end

  # content is a short summary (ids, status, a few fields); fetch the resource for the rest.
  def apply(event)
    content = event.fetch("content")
    case event.fetch("event_type")
    when "subscription_created", "subscription_changed", "subscription_canceled"
      sub = request(:get, "/v1/businesses/#{BIZ}/subscriptions/#{content.dig("subscription", "id")}")
      account_id = sub.dig("metadata", "app_account_id") # set at checkout
      return if account_id.blank?
      at = Time.iso8601(event.fetch("occurred_at"))
      Account.where(id: account_id) # an older event never overwrites newer state
             .where("billing_synced_at IS NULL OR billing_synced_at < ?", at)
             .update_all(tmbilling_customer_id: sub.fetch("customer"), tmbilling_subscription_id: sub.fetch("id"),
                         billing_status: sub.fetch("status"), billing_synced_at: at)
    when "invoice_paid"
      inv = request(:get, "/v1/businesses/#{BIZ}/invoices/#{content.dig("invoice", "id")}")
      if inv.fetch("status") == "paid"
        # Record the receipt. One-time store: inv.dig("metadata", "order_id") is the order.
      end
    when "payment_failed" then nil # no fetch: content["payment"] has amount_minor, currency, invoice, code, message
    else Rails.logger.info("billing webhook: skipped #{event["event_type"]}") # never raise
    end
  end
end
```

## Controllers

```ruby
# app/controllers/billing_controller.rb
class BillingController < ApplicationController
  before_action :require_user # replace with the app's auth (Rails 8 generator: on by default)

  def subscribe
    price = params.require(:price)
    return head :bad_request unless Billing::PRICES.include?(price)
    session = Billing.request(:post, "/v1/businesses/#{Billing::BIZ}/checkout_sessions", {
      items: [{ price:, quantity: 1 }],
      customer: { email: current_user.email },
      metadata: { app_account_id: current_user.account_id.to_s }, # lands on the subscription
      redirect_url: "#{ENV.fetch("APP_URL")}/billing/done", # shows "processing"; the webhook grants access
      cancel_url: "#{ENV.fetch("APP_URL")}/pricing"
    })
    # Valid 24 h by default: create it per click, never store or log it.
    redirect_to session.fetch("url"), allow_other_host: true, status: :see_other
  end

  def manage
    cus = current_user.account.tmbilling_customer_id
    return redirect_to("/pricing", status: :see_other) if cus.blank?
    portal = Billing.request(:post, "/v1/businesses/#{Billing::BIZ}/customers/#{cus}/portal_sessions", {})
    redirect_to portal.fetch("url"), allow_other_host: true, status: :see_other
  end
end
```

```ruby
# app/controllers/billing_webhooks_controller.rb
# ActionController::Base, not ApplicationController: skips the app's sign-in filters.
class BillingWebhooksController < ActionController::Base
  skip_forgery_protection

  def create
    raw = request.raw_post # the exact signed bytes
    return head :unauthorized unless Billing.valid_signature?(raw, request.headers["Tmbilling-Signature"])
    event = JSON.parse(raw)
    ActiveRecord::Base.transaction do # event id and its effects commit together
      seen = BillingEvent.create_or_find_by!(event_id: event.fetch("id")) # unique index on event_id
      Billing.apply(event) if seen.previously_new_record?
    end
    head :ok # an exception above is a 500, and the event comes again
  end
end
```

```ruby
# config/routes.rb
post "billing/subscribe", to: "billing#subscribe"
post "billing/manage",    to: "billing#manage"
post "webhooks/billing",  to: "billing_webhooks#create"
# Dedupe table: bin/rails g model BillingEvent event_id:string:uniq
```

## Gotchas

- Turbo Drive submits forms with `fetch`, which cannot follow a redirect to another host. Turn it
  off on the billing forms: `button_to "Subscribe", "/billing/subscribe", params: { price: "pro-monthly-usd" }, form: { data: { turbo: false } }`.
- `redirect_to` an external URL raises `UnsafeRedirectError` unless you pass `allow_other_host: true`.
- The Rails 8 authentication generator puts `require_authentication` in `ApplicationController`.
  A webhook controller that inherits from it redirects deliveries to the sign-in page.
- `skip_forgery_protection` exists on `ActionController::Base`, not `ActionController::API`
  (which has no CSRF to skip). Keep CSRF on `subscribe` and `manage`.
- Rack middleware that rewrites the body (for example a JSON param normalizer) changes
  `raw_post`. Keep the webhook path out of it.
