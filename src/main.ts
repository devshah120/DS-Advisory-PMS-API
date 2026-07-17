import { NestFactory } from '@nestjs/core';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { AppModule } from './app.module';

/**
 * Emit a `errors` map keyed by property name so clients can render validation
 * failures inline. `message` keeps its default string[] shape for compatibility.
 */
function validationExceptionFactory(errors: ValidationError[]) {
  const flat: Record<string, string> = {};

  const walk = (errs: ValidationError[], prefix = '') => {
    for (const e of errs) {
      const path = prefix ? `${prefix}.${e.property}` : e.property;
      const first = e.constraints && Object.values(e.constraints)[0];
      if (first && !flat[path]) flat[path] = first;
      if (e.children?.length) walk(e.children, path);
    }
  };
  walk(errors);

  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: Object.values(flat),
    errors: flat,
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    })
  );

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 5000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
