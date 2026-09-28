import { randomInt } from 'node:crypto';

import type { EntityManager } from 'typeorm';

import { SEAT_CODE_ALPHABET, SEAT_CODE_BODY_LENGTH, seatCode } from '@arthome/core';

function drawnSeatCode(): string {
  let body = '';
  for (let index = 0; index < SEAT_CODE_BODY_LENGTH; index += 1) {
    body += SEAT_CODE_ALPHABET.charAt(randomInt(SEAT_CODE_ALPHABET.length));
  }
  return seatCode(body);
}

/**
 * `count` codes no seat carries yet, drawn by the service as core leaves it to (seat-code.ts). The
 *   space is 32⁶: at a hundred thousand seats a handful of draws would collide, so each is looked up
 *   and drawn again rather than left to the unique constraint, which would abort the payment.
 */
export async function drawFreeSeatCodes(manager: EntityManager, count: number): Promise<string[]> {
  const codes = new Set<string>();
  while (codes.size < count) {
    const drawn = Array.from({ length: count - codes.size }, drawnSeatCode).filter(
      (code) => !codes.has(code),
    );
    const taken = await manager.query<{ seat_code: string }[]>(
      'SELECT seat_code FROM seat WHERE seat_code = ANY($1)',
      [drawn],
    );
    const takenCodes = new Set(taken.map(({ seat_code }) => seat_code));
    for (const code of drawn) if (!takenCodes.has(code)) codes.add(code);
  }
  return [...codes];
}
