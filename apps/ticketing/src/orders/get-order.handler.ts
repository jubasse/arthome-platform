import { notFound } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OrderState, paymentReturnPath } from '@arthome/core';

import { GetOrder } from './get-order.query.js';
import { handoffOf, orderViewOf, ticketViewsOf, type OrderDetail } from './order-views.js';
import { SeatOrderRow } from './seat-order.entity.js';
import { seatOrderSnapshotOf } from './seat-order.typeorm-repository.js';
import { SeatRow } from './seat.entity.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The order's two tables in one snapshot, so the tickets served are the paid order's. The handoff
 *   rides along while strong authentication is awaited, which is what lets an abandoned one resume.
 *   Someone else's order is a 404, as one that does not exist: a 403 would say it does.
 */
@QueryHandler(GetOrder)
export class GetOrderHandler implements IQueryHandler<GetOrder> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public async execute({ orderId, accountId }: GetOrder): Promise<OrderDetail> {
    const snapshot = await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const row = await manager.findOneBy(SeatOrderRow, { id: orderId, account_id: accountId });
      if (row === null) return null;
      const seats = await manager.find(SeatRow, {
        where: { order_id: orderId },
        order: { seat_code: 'ASC' },
      });
      return seatOrderSnapshotOf(row, seats);
    });
    if (snapshot === null) throw notFound();
    const handoff =
      snapshot.state === OrderState.AWAITING_ACTION
        ? handoffOf(snapshot, `${this.publicWebOrigin}${paymentReturnPath(orderId)}`)
        : null;
    return {
      order: orderViewOf(snapshot),
      tickets: ticketViewsOf(snapshot),
      ...(handoff !== null && { handoff }),
    };
  }
}
