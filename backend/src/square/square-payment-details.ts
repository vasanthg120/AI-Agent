// Pure mapping from Square's Payment object to the sanitized detail block Haive
// stores and shows. An allowlist, never a copy: card fingerprint, BIN, CVV/AVS
// results, auth codes and the like are never read, so they can never be stored
// or leaked. Every field is only set when Square actually sent it.

interface Money {
  amount?: number;
  currency?: string;
}

export interface SquareProcessingFee {
  effectiveAt?: string;
  type?: string;
  amount: number;
  currency: string;
}

export interface SquarePaymentDetails {
  updatedAt?: string;
  totalMoney?: { amount: number; currency: string };
  approvedMoney?: { amount: number; currency: string };
  refundedMoney?: { amount: number; currency: string };
  tipMoney?: { amount: number; currency: string };
  sourceType?: string;
  card?: { brand?: string; last4?: string; cardType?: string; entryMethod?: string; status?: string };
  processingFees?: SquareProcessingFee[];
  locationId?: string;
  orderId?: string;
  customerId?: string;
  referenceId?: string;
  teamMemberId?: string;
  employeeId?: string;
  receiptNumber?: string;
  receiptUrl?: string;
  note?: string;
  productName?: string;
  authorizedAt?: string;
  capturedAt?: string;
  refundIds?: string[];
  /** The Square Invoice that billed this payment's order (matched on order_id exactly) — Square Invoices payments carry no reference_id, so this is the identifier that names the document. */
  squareInvoiceId?: string;
  squareInvoiceNumber?: string;
  squareInvoiceTitle?: string;
}

export interface SquareInvoiceRef {
  id?: string;
  number?: string;
  title?: string;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function money(value: unknown): { amount: number; currency: string } | undefined {
  const m = value as Money | undefined;
  if (!m || typeof m.amount !== 'number' || !Number.isFinite(m.amount) || typeof m.currency !== 'string' || !m.currency) return undefined;
  return { amount: m.amount, currency: m.currency.toUpperCase() };
}

/** Only Square-hosted https receipt pages are ever kept — anything else (including javascript: or http:) is dropped. */
export function safeReceiptUrl(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    const host = url.hostname.toLowerCase();
    const trusted = ['squareup.com', 'square.site', 'squareupsandbox.com', 'squareupstaging.com'];
    return trusted.some((d) => host === d || host.endsWith(`.${d}`)) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function extractSquarePaymentDetails(payment: Record<string, any>, invoice?: SquareInvoiceRef): SquarePaymentDetails {
  const details: SquarePaymentDetails = {};
  const set = <K extends keyof SquarePaymentDetails>(key: K, value: SquarePaymentDetails[K] | undefined) => {
    if (value !== undefined) details[key] = value;
  };
  set('updatedAt', str(payment.updated_at));
  set('totalMoney', money(payment.total_money));
  set('approvedMoney', money(payment.approved_money));
  set('refundedMoney', money(payment.refunded_money));
  set('tipMoney', money(payment.tip_money));
  set('sourceType', str(payment.source_type));

  // Card: brand/last4/type/entry method/status only — never fingerprint, BIN, CVV or AVS.
  const card = payment.card_details?.card;
  const cardInfo = {
    brand: str(card?.card_brand),
    last4: str(card?.last_4),
    cardType: str(card?.card_type),
    entryMethod: str(payment.card_details?.entry_method),
    status: str(payment.card_details?.status),
  };
  if (Object.values(cardInfo).some((v) => v !== undefined)) {
    set('card', Object.fromEntries(Object.entries(cardInfo).filter(([, v]) => v !== undefined)));
  }

  const fees: SquareProcessingFee[] = [];
  for (const fee of Array.isArray(payment.processing_fee) ? payment.processing_fee : []) {
    const m = money(fee?.amount_money);
    if (m) fees.push({ effectiveAt: str(fee.effective_at), type: str(fee.type), ...m });
  }
  if (fees.length) details.processingFees = fees;

  set('locationId', str(payment.location_id));
  set('orderId', str(payment.order_id));
  set('customerId', str(payment.customer_id));
  set('referenceId', str(payment.reference_id));
  set('teamMemberId', str(payment.team_member_id));
  set('employeeId', str(payment.employee_id));
  set('receiptNumber', str(payment.receipt_number));
  set('receiptUrl', safeReceiptUrl(payment.receipt_url));
  set('note', str(payment.note));
  set('productName', str(payment.application_details?.square_product));
  set('authorizedAt', str(payment.card_details?.card_payment_timeline?.authorized_at));
  set('capturedAt', str(payment.card_details?.card_payment_timeline?.captured_at));
  const refundIds = Array.isArray(payment.refund_ids) ? payment.refund_ids.filter((id: unknown): id is string => typeof id === 'string') : [];
  if (refundIds.length) details.refundIds = refundIds;
  set('squareInvoiceId', str(invoice?.id));
  set('squareInvoiceNumber', str(invoice?.number));
  set('squareInvoiceTitle', str(invoice?.title));
  return details;
}

/** Sum of processing fees in the payment's own currency; fees in any other currency are never mixed in. */
export function computeNet(amount: number, currency: string, fees: SquareProcessingFee[] | undefined): { feeTotal: number; net: number } | null {
  if (!fees?.length) return null;
  const cur = currency.toUpperCase();
  if (fees.some((f) => f.currency.toUpperCase() !== cur)) return null;
  const feeTotal = fees.reduce((sum, f) => sum + f.amount, 0);
  return { feeTotal, net: amount - feeTotal };
}
