"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { cors: false, rawBody: true });
    const config = app.get(config_1.ConfigService);
    app.set('trust proxy', 'loopback, uniquelocal');
    app.enableCors({
        origin: config.get('corsOrigin'),
        credentials: true,
    });
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
    }));
    const port = config.get('port') ?? 3000;
    await app.listen(port);
    console.log(`Backend listening on :${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map