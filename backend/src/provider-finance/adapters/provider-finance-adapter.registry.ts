import { Injectable } from '@nestjs/common';
import { AnthropicFinanceAdapter } from './anthropic-finance-adapter.service';
import { GroqFinanceAdapter } from './groq-finance-adapter.service';
import { ProviderFinanceAdapter } from './provider-capability-adapter.interface';

// One adapter per real, connected provider (see FINANCE_TRACKED_PROVIDERS in
// provider-finance.service.ts) — adding a provider later is registering one
// more adapter here, never a change to any caller of get()/all().
@Injectable()
export class ProviderFinanceAdapterRegistry {
  private readonly byProvider: Map<string, ProviderFinanceAdapter>;

  constructor(anthropic: AnthropicFinanceAdapter, groq: GroqFinanceAdapter) {
    const entries: [string, ProviderFinanceAdapter][] = [
      [anthropic.provider, anthropic],
      [groq.provider, groq],
    ];
    this.byProvider = new Map(entries);
  }

  get(provider: string): ProviderFinanceAdapter | undefined {
    return this.byProvider.get(provider);
  }

  all(): ProviderFinanceAdapter[] {
    return [...this.byProvider.values()];
  }
}
