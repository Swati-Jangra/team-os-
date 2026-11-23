import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from '@teamos/shared';

@Injectable()
export class ZodPipe<Out> implements PipeTransform {
  constructor(private readonly schema: ZodType<Out>) {}

  transform(value: unknown): Out {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        undefined,
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}
