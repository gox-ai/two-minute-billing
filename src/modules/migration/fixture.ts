import type {
  MigrationSource,
  SourceCatalog,
  SourceCoupon,
  SourceCouponSet,
  SourceCustomer,
  SourceSubscription,
  SourceUnbilledCharge,
  SourceInvoice,
  SourceCreditNote,
  SourceTransaction,
  SourceEvent,
} from './types'

export interface FixtureData {
  name?: string
  catalog?: Partial<SourceCatalog>
  coupons?: SourceCoupon[]
  couponSets?: SourceCouponSet[]
  customers?: SourceCustomer[]
  subscriptions?: SourceSubscription[]
  unbilledCharges?: SourceUnbilledCharge[]
  invoices?: SourceInvoice[]
  creditNotes?: SourceCreditNote[]
  transactions?: SourceTransaction[]
  events?: SourceEvent[]
}

/** In-memory migration source for tests / dry runs (no external API). */
export class FixtureSource implements MigrationSource {
  readonly name: string
  constructor(private data: FixtureData) {
    this.name = data.name ?? 'fixture'
  }
  async listCatalog(): Promise<SourceCatalog> {
    return {
      groups: this.data.catalog?.groups ?? [],
      products: this.data.catalog?.products ?? [],
      prices: this.data.catalog?.prices ?? [],
      attachedAddons: this.data.catalog?.attachedAddons ?? [],
      differentialPrices: this.data.catalog?.differentialPrices ?? [],
    }
  }
  async listCoupons() {
    return { coupons: this.data.coupons ?? [], couponSets: this.data.couponSets ?? [] }
  }
  async listCustomers() {
    return this.data.customers ?? []
  }
  async listSubscriptions() {
    return this.data.subscriptions ?? []
  }
  async listUnbilledCharges() {
    return this.data.unbilledCharges ?? []
  }
  async listInvoices() {
    return this.data.invoices ?? []
  }
  async listCreditNotes() {
    return this.data.creditNotes ?? []
  }
  async listTransactions() {
    return this.data.transactions ?? []
  }
  async listEvents() {
    return this.data.events ?? []
  }
}
