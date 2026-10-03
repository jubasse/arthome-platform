import { unauthenticated } from '@arthome-platform/http-edge';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Account } from './account.entity.js';

/** What the storefront's `ViewerContext.account` shows of an account (storefront.yaml). */
export interface Viewer {
  readonly publicHandle: string;
  readonly emailVerified: boolean;
}

export function viewerOf(account: Account): Viewer {
  return {
    publicHandle: account.public_handle,
    emailVerified: account.email_verified_at !== null,
  };
}

@Injectable()
export class ViewerService {
  public constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public async viewer(accountId: string): Promise<Viewer> {
    const account = await this.dataSource.manager.findOneBy(Account, { id: accountId });
    if (account === null) throw unauthenticated();
    return viewerOf(account);
  }
}
