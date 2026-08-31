declare const _default: () => {
    port: number;
    nodeEnv: string;
    corsOrigin: string;
    mongoUri: string;
    pythonAgentUrl: string;
    redisUrl: string;
    jwt: {
        secret: string | undefined;
        expiresIn: string;
    };
    encryptionKey: string;
    mail: {
        host: string;
        port: number;
        user: string;
        password: string;
        from: string;
    };
    webPush: {
        publicKey: string;
        privateKey: string;
        subject: string;
    };
    integrations: {
        crm: {
            baseUrl: string;
            apiKey: string;
        };
        msGraph: {
            clientId: string;
            clientSecret: string;
            redirectUri: string;
            adminConsentRedirectUri: string;
        };
        google: {
            clientId: string;
            clientSecret: string;
            redirectUri: string;
        };
    };
    oauth: {
        google: {
            clientId: string;
            clientSecret: string;
            redirectUri: string;
        };
        microsoft: {
            clientId: string;
            clientSecret: string;
            redirectUri: string;
            tenant: string;
        };
        github: {
            clientId: string;
            clientSecret: string;
            redirectUri: string;
        };
    };
    billing: {
        creditValueInCurrency: number;
        targetGrossMargin: number;
        freeTrialCredits: number;
        autoRechargeDefault: boolean;
        reservationCeilingCredits: number;
        reservationTimeoutMinutes: number;
        lowBalanceThresholdCredits: number;
        currency: string;
        usdToCurrencyRate: number;
        autoPayMaxConsecutiveFailures: number;
        orgScopingEnabled: boolean;
        subscriptionRenewalGraceAttempts: number;
        paymentMode: string;
        activePaymentProvider: string;
        razorpay: {
            live: {
                keyId: string;
                keySecret: string;
                webhookSecret: string;
            };
            test: {
                keyId: string;
                keySecret: string;
                webhookSecret: string;
            };
        };
        stripe: {
            live: {
                secretKey: string;
                publishableKey: string;
                webhookSecret: string;
            };
            test: {
                secretKey: string;
                publishableKey: string;
                webhookSecret: string;
            };
        };
        cashfree: {
            live: {
                clientId: string;
                clientSecret: string;
                webhookSecret: string;
            };
            test: {
                clientId: string;
                clientSecret: string;
                webhookSecret: string;
            };
            env: string;
        };
    };
};
export default _default;
