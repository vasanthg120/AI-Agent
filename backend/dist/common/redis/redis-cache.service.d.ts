import { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
export declare class RedisCacheService implements OnModuleDestroy {
    private readonly logger;
    private readonly client;
    private down;
    constructor(config: ConfigService);
    private where;
    private get ready();
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    del(...keys: string[]): Promise<void>;
    onModuleDestroy(): void;
}
