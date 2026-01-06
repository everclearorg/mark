/* eslint-disable @typescript-eslint/no-empty-object-type */
import { PublicKey, Connection } from '@solana/web3.js';
import * as borsh from '@coral-xyz/borsh';
import { PROGRAM_ID } from '../programId';

export interface AllowedOfframpFields {}

export interface AllowedOfframpJSON {}

export class AllowedOfframp {
  static readonly discriminator = Buffer.from([247, 97, 179, 16, 207, 36, 236, 132]);

  static readonly layout = borsh.struct([]);

  constructor(_fields: AllowedOfframpFields) {}

  static async fetch(
    c: Connection,
    address: PublicKey,
    programId: PublicKey = PROGRAM_ID,
  ): Promise<AllowedOfframp | null> {
    const info = await c.getAccountInfo(address);

    if (info === null) {
      return null;
    }
    if (!info.owner.equals(programId)) {
      throw new Error("account doesn't belong to this program");
    }

    return this.decode(info.data);
  }

  static async fetchMultiple(
    c: Connection,
    addresses: PublicKey[],
    programId: PublicKey = PROGRAM_ID,
  ): Promise<Array<AllowedOfframp | null>> {
    const infos = await c.getMultipleAccountsInfo(addresses);

    return infos.map((info) => {
      if (info === null) {
        return null;
      }
      if (!info.owner.equals(programId)) {
        throw new Error("account doesn't belong to this program");
      }

      return this.decode(info.data);
    });
  }

  static decode(data: Buffer): AllowedOfframp {
    if (!data.slice(0, 8).equals(AllowedOfframp.discriminator)) {
      throw new Error('invalid account discriminator');
    }

    AllowedOfframp.layout.decode(data.slice(8));

    return new AllowedOfframp({});
  }

  toJSON(): AllowedOfframpJSON {
    return {};
  }

  static fromJSON(_obj: AllowedOfframpJSON): AllowedOfframp {
    return new AllowedOfframp({});
  }
}
