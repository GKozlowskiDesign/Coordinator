// x402-paywall.ts
import type { Request, Response, NextFunction } from 'express';

type Fiat = { currency: 'USD' | 'EUR'; value: string };
type Onchain = { currency: 'SOL' | 'USDC'; value: string };
type Price = Fiat | Onchain;
type Resolvable<T> = T | ((req: Request) => T | Promise<T>);

export function paywall(resourceId: Resolvable<string>, price: Resolvable<Price>) {
  const receiver = process.env.X402_RECEIVER || '';
  const facilitatorRaw = process.env.X402_FACILITATOR || '';
  const facilitator = facilitatorRaw.replace(/\/$/, '');
  const DEMO = process.env.X402_DEMO === '1';

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.header('X-PAYMENT') || '';

      const resource = typeof resourceId === 'function' ? await resourceId(req) : resourceId;
      const reqPrice = typeof price === 'function' ? await price(req) : price;

      // Demo short-circuit (lets you show UI without a real payment)
      if (DEMO && token === 'demo-okay') {
        (req as any).x402 = { ok: true, settled: true, demo: true, resource };
        return next();
      }

      if (!token) {
        return res.status(402).json({
          paymentRequired: true,
          paymentRequirements: {
            receiver,
            resource,
            ...reqPrice,
            facilitator,
            header: 'X-PAYMENT',
          },
        });
      }

      if (!receiver || !facilitator) {
        return res.status(402).json({ paymentRequired: true, error: 'x402_env_missing' });
      }

      const r = await fetch(`${facilitator}/v1/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ xPayment: token, receiver, resourceId: resource }),
      });

      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(402).json({ paymentRequired: true, error: `verify_failed:${t}` });
      }

      const data: any = await r.json().catch(() => ({}));
      if (!data || data.ok !== true || data.settled !== true) {
        return res.status(402).json({ paymentRequired: true, error: 'not_settled' });
      }

      (req as any).x402 = data;
      next();
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || 'x402_internal_error' });
    }
  };
}
