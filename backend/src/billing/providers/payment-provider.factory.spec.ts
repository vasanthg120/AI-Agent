import { ConfigService } from '@nestjs/config';
import { paymentProviderFactory } from './payment-provider.factory';

// Plain unit test — paymentProviderFactory is an exported function with no
// Mongoose/Nest wiring of its own beyond the model it's handed, so a real
// TestingModule/Mongo connection isn't needed to verify its selection logic.

describe('paymentProviderFactory', () => {
  const razorpay = { providerKey: 'razorpay' } as never;
  const stripe = { providerKey: 'stripe' } as never;
  const cashfree = { providerKey: 'cashfree' } as never;

  function configStub(activePaymentProvider?: string): ConfigService {
    return { get: (key: string) => (key === 'billing.activePaymentProvider' ? activePaymentProvider : undefined) } as unknown as ConfigService;
  }
  function settingsModelStub(defaultPaymentProvider?: string) {
    return { findOne: () => ({ exec: async () => (defaultPaymentProvider ? { defaultPaymentProvider } : null) }) } as never;
  }

  it('falls back to the env var when no admin default is configured', async () => {
    const selected = await paymentProviderFactory(configStub('stripe'), razorpay, stripe, cashfree, settingsModelStub(undefined));
    expect(selected).toBe(stripe);
  });

  it('falls back to razorpay when neither the admin default nor the env var is set', async () => {
    const selected = await paymentProviderFactory(configStub(undefined), razorpay, stripe, cashfree, settingsModelStub(undefined));
    expect(selected).toBe(razorpay);
  });

  it('prefers the admin-configured BillingSettings.defaultPaymentProvider over the env var', async () => {
    const selected = await paymentProviderFactory(configStub('razorpay'), razorpay, stripe, cashfree, settingsModelStub('cashfree'));
    expect(selected).toBe(cashfree);
  });
});
