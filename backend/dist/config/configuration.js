"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = () => ({
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
    encryptionKey: process.env.ENCRYPTION_KEY ?? '',
    mail: {
        host: process.env.SMTP_HOST ?? '',
        port: parseInt(process.env.SMTP_PORT ?? '587', 10),
        user: process.env.SMTP_USER ?? '',
        password: process.env.SMTP_PASSWORD ?? '',
        from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    },
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
            adminConsentRedirectUri: process.env.MS_GRAPH_ADMIN_CONSENT_REDIRECT_URI ?? 'http://localhost:3000/outlook/admin-consent-callback',
        },
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID ?? '',
            clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
            redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/gmail/callback',
        },
    },
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
            tenant: process.env.MICROSOFT_OAUTH_TENANT ?? 'common',
        },
        github: {
            clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? '',
            clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
            redirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/auth/oauth/github/callback',
        },
    },
    billing: {
        creditValueInCurrency: parseFloat(process.env.CREDIT_VALUE_INR ?? '1'),
        targetGrossMargin: parseFloat(process.env.TARGET_GROSS_MARGIN ?? '0.5'),
        freeTrialCredits: parseInt(process.env.FREE_TRIAL_CREDITS ?? '20', 10),
        autoRechargeDefault: (process.env.AUTO_RECHARGE_DEFAULT ?? 'false').toLowerCase() === 'true',
        reservationCeilingCredits: parseInt(process.env.RESERVATION_CEILING_CREDITS ?? '500', 10),
        reservationTimeoutMinutes: parseInt(process.env.RESERVATION_TIMEOUT_MINUTES ?? '10', 10),
        lowBalanceThresholdCredits: parseInt(process.env.LOW_BALANCE_THRESHOLD_CREDITS ?? '200', 10),
        currency: (process.env.BILLING_CURRENCY ?? 'INR').toUpperCase(),
        usdToCurrencyRate: parseFloat(process.env.USD_TO_CURRENCY_RATE ?? ((process.env.BILLING_CURRENCY ?? 'INR').toUpperCase() === 'USD' ? '1' : '83')),
        autoPayMaxConsecutiveFailures: parseInt(process.env.AUTOPAY_MAX_CONSECUTIVE_FAILURES ?? '3', 10),
        orgScopingEnabled: (process.env.BILLING_ORG_SCOPED_WALLETS ?? 'false').toLowerCase() === 'true',
        subscriptionRenewalGraceAttempts: parseInt(process.env.SUBSCRIPTION_RENEWAL_GRACE_ATTEMPTS ?? '3', 10),
        paymentMode: (process.env.PAYMENT_MODE ?? 'test').toLowerCase() === 'live' ? 'live' : 'test',
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
            env: process.env.CASHFREE_ENV ?? '',
        },
    },
});
//# sourceMappingURL=configuration.js.map