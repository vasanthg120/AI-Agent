import { Injectable } from '@nestjs/common';
import { CapabilityMatrix, ProviderCapability, ProviderFinanceAdapter } from './provider-capability-adapter.interface';

// Groq, verified live against console.groq.com/docs (spend-limits,
// rate-limits pages) and the installed groq==1.6.0 SDK's own
// _exceptions.py: no balance, usage/cost, invoice, or auto-recharge API
// exists at all — postpaid, billed in arrears, every one of those is
// Console-only. The only real, automatable capability is confirmed
// exhaustion detection: a configured spend limit returns HTTP 400 with
// `error.code === "blocked_api_access"` (confirmed on console.groq.com/
// docs/spend-limits) — detected in python-agent's tracing.py, not here;
// this adapter only ever DECLARES that capability for the dashboard.
@Injectable()
export class GroqFinanceAdapter implements ProviderFinanceAdapter {
  readonly provider = 'groq';

  getCapabilities(): CapabilityMatrix {
    const noApi = { status: 'UNSUPPORTED' as const, detail: 'Groq exposes no API for this — Console-only (verified against official docs).' };
    return {
      [ProviderCapability.BALANCE_READ]: noApi,
      [ProviderCapability.USAGE_COST_READ]: noApi,
      [ProviderCapability.INVOICE_HISTORY_READ]: noApi,
      [ProviderCapability.PAYMENT_HISTORY_READ]: { status: 'UNSUPPORTED', detail: 'No provider-side payment/transaction API — recorded payments below are Haive\'s own ledger.' },
      [ProviderCapability.AUTO_RECHARGE_READ]: noApi,
      [ProviderCapability.AUTO_RECHARGE_CONFIGURE]: noApi,
      [ProviderCapability.SPEND_LIMIT_READ]: noApi,
      [ProviderCapability.SPEND_LIMIT_CONFIGURE]: noApi,
      [ProviderCapability.RATE_LIMIT_READ]: noApi,
      [ProviderCapability.EXHAUSTION_DETECTION]: { status: 'SUPPORTED', detail: 'A confirmed HTTP 400 blocked_api_access from a real API call automatically marks this provider exhausted.' },
    };
  }
}
