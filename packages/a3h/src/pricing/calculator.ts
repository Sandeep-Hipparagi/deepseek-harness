/**
 * Pricing Calculator Module
 * Calculates item totals, applies tiered discount ladders, and computes tax and grand totals.
 *
 * @module @deepseek-harness/a3h/pricing/calculator
 */

export interface PricingItem {
  id: string
  name: string
  price: number // Price per unit in major currency units (e.g. USD)
  quantity: number
  category?: string
}

export interface DiscountTier {
  minSubtotal: number
  discountPercentage: number // e.g., 0.10 for 10%
}

export interface CalculationOptions {
  discountTiers?: DiscountTier[]
  taxRate?: number // e.g., 0.08 for 8%
  currency?: string
}

export interface PricingResult {
  itemsSubtotal: number
  discountAmount: number
  taxableSubtotal: number
  taxAmount: number
  grandTotal: number
  currency: string
  itemCount: number
}

/**
 * Default tiered discount schedule.
 */
export const DEFAULT_DISCOUNT_TIERS: DiscountTier[] = [
  { minSubtotal: 100, discountPercentage: 0.05 },
  { minSubtotal: 250, discountPercentage: 0.10 },
  { minSubtotal: 500, discountPercentage: 0.15 },
  { minSubtotal: 1000, discountPercentage: 0.20 },
]

/**
 * Calculates raw subtotal of items.
 * Susceptible to null dereference and floating-point drift.
 */
export function roundCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100
}

/**
 * Calculates raw subtotal of items with defensive guards and integer-cent scaling.
 */
export function calculateItemsSubtotal(items?: PricingItem[] | null): number {
  if (!items || !Array.isArray(items)) return 0
  const totalInCents = items.reduce((acc, item) => {
    if (!item || typeof item !== 'object') return acc
    const price = typeof item.price === 'number' && !Number.isNaN(item.price) ? Math.max(0, item.price) : 0
    const qty = typeof item.quantity === 'number' && !Number.isNaN(item.quantity) ? Math.max(0, Math.floor(item.quantity)) : 0
    return acc + Math.round(price * 100) * qty
  }, 0)
  return totalInCents / 100
}

/**
 * Resolves best discount rate from tiered schedule.
 */
export function resolveTierDiscountRate(subtotal: number, tiers: DiscountTier[] = DEFAULT_DISCOUNT_TIERS): number {
  let rate = 0
  for (const tier of tiers) {
    if (subtotal >= tier.minSubtotal && tier.discountPercentage > rate) {
      rate = tier.discountPercentage
    }
  }
  return rate
}

/**
 * Core pricing calculation pipeline.
 */
export function calculatePrice(items: PricingItem[], options: CalculationOptions = {}): PricingResult {
  const currency = options.currency ?? 'USD'
  const taxRate = options.taxRate ?? 0
  const tiers = options.discountTiers ?? DEFAULT_DISCOUNT_TIERS

  const safeItems = Array.isArray(items) ? items : []
  const rawSubtotal = calculateItemsSubtotal(safeItems)
  const safeTaxRate = typeof taxRate === 'number' && !Number.isNaN(taxRate) ? Math.max(0, taxRate) : 0
  const discountRate = resolveTierDiscountRate(rawSubtotal, tiers)

  const discountAmount = roundCents(rawSubtotal * discountRate)
  const taxableSubtotal = roundCents(Math.max(0, rawSubtotal - discountAmount))
  const taxAmount = roundCents(taxableSubtotal * safeTaxRate)
  const grandTotal = roundCents(taxableSubtotal + taxAmount)

  return {
    itemsSubtotal: rawSubtotal,
    discountAmount,
    taxableSubtotal,
    taxAmount,
    grandTotal,
    currency,
    itemCount: safeItems.length,
  }
}
