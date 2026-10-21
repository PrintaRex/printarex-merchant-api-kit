/**
 * What to tell the shopper, and what the merchant must do, for each hold reason.
 * The list is open: PrintaRex can add reasons, so always keep a fallback.
 */
const HOLD_TEXT: Record<string, { shopper: string; merchant: string }> = {
  awaiting_approval: { shopper: 'Your order is being reviewed.', merchant: 'Approve the order in the PrintaRex portal.' },
  delayed_submit: { shopper: 'Your order is being reviewed.', merchant: 'The order is submitted automatically after your delay. Approve it now to skip the wait.' },
  personalization_review: { shopper: 'Your personalised item is being checked.', merchant: 'Review the personalisation in the PrintaRex portal.' },
  velocity_review: { shopper: 'Your order is being reviewed.', merchant: 'New API keys hold their first orders. Approve this one in the PrintaRex portal.' },
  missing_phone: { shopper: 'We need a phone number for the courier.', merchant: 'Add the buyer phone number (this page does it through PATCH /orders/{id}/shipping-address).' },
  payment_method_missing: { shopper: 'Your order is being prepared.', merchant: 'Add a card in the PrintaRex portal so PrintaRex can charge production costs.' },
  payment_failed: { shopper: 'Your order is being prepared.', merchant: 'The PrintaRex charge failed. Update your card in the portal.' },
  payment_expired: { shopper: 'Your order is being prepared.', merchant: 'The payment window expired. Retry the payment in the portal.' },
  payment_review: { shopper: 'Your order is being prepared.', merchant: 'PrintaRex is reviewing the payment. No action needed.' },
  payment_processing_unavailable: { shopper: 'Your order is being prepared.', merchant: 'Payments are temporarily unavailable at PrintaRex. No action needed.' },
  provider_selection_required: { shopper: 'Your order is being prepared.', merchant: 'Choose a production partner in the PrintaRex portal.' },
  processing: { shopper: 'Your order is being prepared.', merchant: 'PrintaRex is processing the order. No action needed.' },
};

const FALLBACK = { shopper: 'Your order is being prepared.', merchant: 'Open the order in the PrintaRex portal for details.' };

export const holdText = (code: string) => HOLD_TEXT[code] ?? FALLBACK;

/** Statuses are an open list too: unknown values are shown as "in progress". */
const STATUS_TEXT: Record<string, string> = {
  received: 'Received',
  on_hold: 'On hold',
  awaiting_provider: 'Waiting for the print partner',
  awaiting_payment: 'Accepted by the print partner',
  in_production: 'In production',
  shipped: 'Shipped',
  delivered: 'Delivered',
  returned: 'Returned',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

export const statusText = (status: string | null) => (status ? (STATUS_TEXT[status] ?? 'In progress') : 'Sending to PrintaRex');
