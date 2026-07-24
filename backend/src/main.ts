import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Allow the browser dashboard (Vite dev server, different origin) to call the
  // API. The ingestion webhook stays protected by its API-key guard regardless.
  app.enableCors();
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/(.*)'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Guarantee no unhandled error ever leaks a stack trace to a client.
  app.useGlobalFilters(new AllExceptionsFilter());
  // Let module shutdown hooks run (e.g. closing the health Redis client).
  app.enableShutdownHooks();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
