/** The storefront's page of the order, which reads `getOrder`; no document names it yet (HANDOVER §3). */
export function interimPaymentReturnUrlOf(publicWebOrigin: string, orderId: string): string {
  return `${publicWebOrigin}/orders/${orderId}`;
}
