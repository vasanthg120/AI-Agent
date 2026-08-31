export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/agent',
  pythonAgentUrl: process.env.PYTHON_AGENT_URL ?? 'http://localhost:8000',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
  },
  // See common/encryption/encryption.service.ts — falls back to deriving
  // from jwt.secret if unset, so this is optional, not required.
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  mail: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    // Falls back to SMTP_USER since most providers require the From address
    // to match (or be an alias of) the authenticated account anyway.
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  },
  // Web Push (Settings > Notifications' Desktop/Mobile toggles) — one-time
  // generated via web-push's generateVAPIDKeys(), see backend/.env's own
  // comment. Unset publicKey/privateKey makes WebPushService fail open
  // (warns once, no-ops forever), same convention as MailService with no
  // SMTP_HOST configured.
  webPush: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? '',
  },
  integrations: {
    crm: {
      baseUrl: process.env.CRM_BASE_URL ?? '',
      apiKey: process.env.CRM_API_KEY ?? '',
    },
    msGraph: {
      clientId: process.env.MS_GRAPH_CLIENT_ID ?? '',
      clientSecret: process.env.MS_GRAPH_CLIENT_SECRET ?? '',
      redirectUri: process.env.MS_GRAPH_REDIRECT_URI ?? 'http://localhost:3000/outlook/callback',
      // Must also be registered as a Redirect URI on this same Azure App
      // Registration — Microsoft's /adminconsent endpoint redirects here
      // with ?tenant=...&admin_consent=True on success (no `code`, unlike
      // the regular OAuth callback above, hence the separate route).
      adminConsentRedirectUri:
        process.env.MS_GRAPH_ADMIN_CONSENT_REDIRECT_URI ?? 'http://localhost:3000/outlook/admin-consent-callback',
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/gmail/callback',
    },
  },
  // Separate from `integrations.google`/`integrations.msGraph` above —
  // those are per-user delegated Gmail/Outlook *mailbox* connections
  // (different scopes, different app registration in most setups). These
  // are "Sign in with ..." login apps; reusing the mailbox app's client
  // ID/secret would work too (Google/Microsoft both allow multiple redirect
  // URIs per app) but keeping them distinct avoids ever having a login
  // consent screen ask for Gmail.send/Mail.Read scopes.
  oauth: {
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/auth/oauth/google/callback',
    },
    microsoft: {
      clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: process.env.MICROSOFT_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/auth/oauth/microsoft/callback',
      // 'common' accepts both personal Microsoft accounts and work/school
      // (Azure AD) accounts — narrow to a specific tenant ID via env if the
      // app registration is restricted to one organization.
      tenant: process.env.MICROSOFT_OAUTH_TENANT ?? 'common',
    },
    github: {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/auth/oauth/github/callback',
    },
  },
  // Haive Credits billing — see billing/pricing.service.ts for the one place
  // creditValueUsd/targetGrossMargin actually get used (never hardcode the
  // formula elsewhere). Razorpay keys are optional: RazorpayPaymentProvider
  // falls back to a "simulated" mode (logs one warning, every charge/webhook
  // call short-circuits to a fake success) when unset — same fail-open-with-
  // warning shape as EncryptionService/MailService.
  billing: {
    // 1 Haive Credit = 1 unit of billing.currency (₹1 by default) — the
    // platform's core credit-value business rule. Not USD-pegged.
    creditValueInCurrency: parseFloat(process.env.CREDIT_VALUE_INR ?? '1'),
    targetGrossMargin: parseFloat(process.env.TARGET_GROSS_MARGIN ?? '0.5'),
    // Granted exactly once per organization, on first wallet creation (see
    // WalletService.getOrCreateWallet) — an auditable FREE_TRIAL ledger row
    // is written alongside it, only on the insert that actually created the
    // wallet, so retries/races can never grant it twice.
    freeTrialCredits: parseInt(process.env.FREE_TRIAL_CREDITS ?? '20', 10),
    // Seeds Wallet.autoPay.enabled for a newly created wallet — Auto
    // Recharge itself still requires a saved payment method before it can
    // actually trigger, regardless of this default.
    autoRechargeDefault: (process.env.AUTO_RECHARGE_DEFAULT ?? 'false').toLowerCase() === 'true',
    // Flat per-turn reservation ceiling — a chat turn's real cost is unknown
    // until the LLM responds (it may take several tool-calling rounds), so
    // this is a deliberately generous upper bound checked before any LLM
    // call is made, not an attempt to estimate the real cost in advance.
    reservationCeilingCredits: parseInt(process.env.RESERVATION_CEILING_CREDITS ?? '500', 10),
    reservationTimeoutMinutes: parseInt(process.env.RESERVATION_TIMEOUT_MINUTES ?? '10', 10),
    lowBalanceThresholdCredits: parseInt(process.env.LOW_BALANCE_THRESHOLD_CREDITS ?? '200', 10),
    // What credit packages are actually priced/charged in — provider/margin
    // accounting stays in USD internally regardless of this, bridged only
    // at the purchase-package price boundary (see PricingService.toUsd/
    // fromUsd). Not hardcoded to INR anymore — set BILLING_CURRENCY to
    // whatever ISO 4217 code the active gateway should charge in.
    currency: (process.env.BILLING_CURRENCY ?? 'INR').toUpperCase(),
    // Defaults to 1 (no conversion) when BILLING_CURRENCY is already USD,
    // so switching to USD works out of the box without also having to set
    // USD_TO_CURRENCY_RATE — only non-USD currencies need a real rate.
    usdToCurrencyRate: parseFloat(
      process.env.USD_TO_CURRENCY_RATE ?? ((process.env.BILLING_CURRENCY ?? 'INR').toUpperCase() === 'USD' ? '1' : '83'),
    ),
    autoPayMaxConsecutiveFailures: parseInt(process.env.AUTOPAY_MAX_CONSECUTIVE_FAILURES ?? '3', 10),
    // Phase 0 of the org-scoped billing extension (see
    // billing-migration.service.ts and billing.controller.ts's tenantKey()):
    // every BillingController route passes user.sub as the wallet's tenant
    // key today (see that controller's own header comment) — flipping this
    // to true switches it to the real user.organizationId instead. Stays
    // false until a dry-run + real migration
    // (POST /billing/admin/migrate-organization-wallets) has been run in
    // this environment; default off means zero behavior change.
    orgScopingEnabled: (process.env.BILLING_ORG_SCOPED_WALLETS ?? 'false').toLowerCase() === 'true',
    // Phase 2 (subscriptions, see subscription-renewal.service.ts): how many
    // consecutive renewal charge failures a BillingSubscription tolerates
    // (staying 'past_due', retried every cron tick) before it's marked
    // 'expired' and stops being retried at all.
    subscriptionRenewalGraceAttempts: parseInt(process.env.SUBSCRIPTION_RENEWAL_GRACE_ATTEMPTS ?? '3', 10),
    // One global toggle picks which key set every configured gateway reads
    // — same behavior for every request, changed by redeploying with a
    // different env var, not a runtime switch. 'live' processes real money;
    // 'test' (the default) uses each gateway's sandbox keys/base URLs.
    paymentMode: (process.env.PAYMENT_MODE ?? 'test').toLowerCase() === 'live' ? 'live' : 'test',
    // Which PaymentProviderAdapter is bound to the PAYMENT_PROVIDER token
    // (see billing/providers/payment-provider.factory.ts). All three can be
    // configured simultaneously (e.g. mid-migration); only this one is
    // actually used for new checkouts/AutoPay charges.
    activePaymentProvider: (process.env.ACTIVE_PAYMENT_PROVIDER ?? 'razorpay').toLowerCase(),
    razorpay: {
      live: {
        keyId: process.env.RAZORPAY_KEY_ID ?? '',
        keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
      },
      test: {
        keyId: process.env.RAZORPAY_KEY_ID_TEST ?? '',
        keySecret: process.env.RAZORPAY_KEY_SECRET_TEST ?? '',
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET_TEST ?? '',
      },
    },
    stripe: {
      live: {
        secretKey: process.env.STRIPE_SECRET_KEY ?? '',
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
      },
      test: {
        secretKey: process.env.STRIPE_SECRET_KEY_TEST ?? '',
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY_TEST ?? '',
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET_TEST ?? '',
      },
    },
    cashfree: {
      live: {
        clientId: process.env.CASHFREE_CLIENT_ID ?? '',
        clientSecret: process.env.CASHFREE_CLIENT_SECRET ?? '',
        webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET ?? '',
      },
      test: {
        clientId: process.env.CASHFREE_CLIENT_ID_TEST ?? '',
        clientSecret: process.env.CASHFREE_CLIENT_SECRET_TEST ?? '',
        webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET_TEST ?? '',
      },
      // Cashfree's SDK takes its own PRODUCTION/SANDBOX enum separately
      // from key selection — derived from paymentMode by default, but
      // overridable if a deployment ever needs to decouple the two.
      env: process.env.CASHFREE_ENV ?? '',
    },
  },
});
