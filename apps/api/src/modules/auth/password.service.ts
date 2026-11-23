import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** argon2id (the @node-rs default algorithm) with library-default OWASP-grade cost parameters. */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /** Burns equivalent CPU for unknown emails so response time doesn't reveal account existence. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= hash('dummy-password-for-timing-equalisation');
    await this.verify(await this.dummyHash, password);
  }
}
