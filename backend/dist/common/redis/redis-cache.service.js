"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var RedisCacheService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCacheService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const ioredis_1 = __importDefault(require("ioredis"));
const MAX_RECONNECT_DELAY_MS = 30_000;
let RedisCacheService = RedisCacheService_1 = class RedisCacheService {
    constructor(config) {
        this.logger = new common_1.Logger(RedisCacheService_1.name);
        this.down = false;
        const url = config.get('redisUrl');
        this.client = new ioredis_1.default(url, {
            maxRetriesPerRequest: 2,
            enableOfflineQueue: false,
            retryStrategy: (times) => Math.min(times * 500, MAX_RECONNECT_DELAY_MS),
        });
        this.client.on('error', (err) => {
            if (this.down)
                return;
            this.down = true;
            const why = err.message || err.code || 'no answer';
            this.logger.warn(`Redis cache unavailable (${why}) at ${this.where(url)} — carrying on without the cache; it is used again once Redis is back.`);
        });
        this.client.on('ready', () => {
            if (this.down)
                this.logger.log('Redis cache is back.');
            this.down = false;
        });
    }
    where(url) {
        try {
            const u = new URL(url);
            return `${u.hostname}:${u.port || '6379'}`;
        }
        catch {
            return 'the configured address';
        }
    }
    get ready() {
        return this.client.status === 'ready';
    }
    async get(key) {
        if (!this.ready)
            return null;
        try {
            const raw = await this.client.get(key);
            return raw ? JSON.parse(raw) : null;
        }
        catch {
            return null;
        }
    }
    async set(key, value, ttlSeconds) {
        if (!this.ready)
            return;
        try {
            await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        }
        catch {
        }
    }
    async del(...keys) {
        if (!this.ready)
            return;
        try {
            if (keys.length)
                await this.client.del(keys);
        }
        catch {
        }
    }
    onModuleDestroy() {
        this.client.disconnect();
    }
};
exports.RedisCacheService = RedisCacheService;
exports.RedisCacheService = RedisCacheService = RedisCacheService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], RedisCacheService);
//# sourceMappingURL=redis-cache.service.js.map