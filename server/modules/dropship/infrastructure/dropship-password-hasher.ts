import bcrypt from "bcrypt";
import type { DropshipPasswordHasher } from "../application/dropship-auth-service";

const BCRYPT_COST = 12;

export class BcryptDropshipPasswordHasher implements DropshipPasswordHasher {
  readonly algorithm = `bcrypt:${BCRYPT_COST}`;

  async hash(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_COST);
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(password, passwordHash);
  }
}
