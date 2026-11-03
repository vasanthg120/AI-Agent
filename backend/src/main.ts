import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true exposes req.rawBody (the exact pre-parsed bytes) on every
  // request without changing existing routes' req.body JSON parsing at
  // all — needed only by billing-webhook.controller.ts, which must verify
  // Razorpay's HMAC signature against the literal bytes Razorpay signed,
  // not a re-serialized JSON.stringify(req.body) that could differ in
  // whitespace/key order.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false, rawBody: true });
  const config = app.get(ConfigService);

  // In production the backend sits behind Nginx (and Docker's network): without this, req.ip is the
  // proxy's address for everyone — every user would share one rate limit (ThrottlerGuard) and every
  // session/audit entry would show the proxy. Only a proxy on this machine or a private network
  // (loopback, Docker's 172.16/12, 10/8, 192.168/16) is believed about the client's real address.
  app.set('trust proxy', 'loopback, uniquelocal');

  app.enableCors({
    origin: config.get<string>('corsOrigin'),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend listening on :${port}`);
}

bootstrap();
